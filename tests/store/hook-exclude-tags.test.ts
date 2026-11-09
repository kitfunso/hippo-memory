// pinnedInject.excludeTags: the hook block leaves out a row carrying a listed tag, on every read it makes.
// Real SQLite stores in tmp dirs, no mocks.
import type { FullContext } from '../_helpers/api-ctx.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adminActor, userRulesGet } from '../../src/api/index.js';
import { buildPromptHookContext } from '../../src/api/prompt-hook.js';
import { USER_RULE_TAG } from '../../src/api/context/user-rule.js';
import type { HippoConfig } from '../../src/base/config/config.js';
import type { MemoryEntry } from '../../src/base/memory/entry.js';
import { promptSearchTerms } from '../../src/base/rank/prompt-recall.js';
import type { AmbientAdmission } from '../../src/base/ports/store.js';
import { log } from '../../src/base/util/log.js';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { loadConfig } from '../../src/host/config-file.js';
import { writeEntryDbOnly } from '../../src/store/sqlite/entries/entry-writes.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { sessionPerTest } from '../_helpers/session-per-test.js';
import { initTestStore } from '../_helpers/store-template.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const { writeEntry, apiCtx } = sessionPerTest();

const DIGEST = 'session-digest';
const PROJECT = { name: 'proj-a', legacyName: 'proj-a' };
const PROMPT = 'postgres migration rollback deploy checklist';
const WINDOW = 100;

let local: string;
let ctx: FullContext;

// A root loads config once per command, so a test that writes config.json reloads ctx.config as the next command would.
function writeConfig(pinnedInject: Partial<HippoConfig['pinnedInject']>): void {
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pinnedInject }));
  ctx = { ...ctx, config: loadConfig(local) };
}

beforeEach(() => {
  const tmp = makeRoot('hook-exclude-tags', { init: false });
  local = path.join(tmp, 'local', '.hippo');
  const globalRoot = path.join(tmp, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initTestStore(local);
  initTestStore(globalRoot);
  vi.stubEnv('HIPPO_HOME', globalRoot);
  ctx = apiCtx(local, 'default', adminActor('hook-exclude-tags-test'));
});

/** A row filed under the project, `day` days into 2026 so a higher day is newer. */
function row(content: string, day: number, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const created = new Date(Date.UTC(2026, 0, 1 + day)).toISOString();
  return { ...createMemory(content), originProject: PROJECT.name, created, ...extra };
}

function seedMany(rows: readonly MemoryEntry[]): void {
  const db = openHippoDb(local);
  try {
    db.exec('BEGIN');
    for (const r of rows) writeEntryDbOnly(db, r);
    db.exec('COMMIT');
  } finally {
    closeHippoDb(db);
  }
}

const ruleText = (n: number): string => `Rule ${n}: run integration suite number ${n} before every push to main`;
const digestText = (n: number): string => `Digest ${n}: this session moved the billing worker pool to a new queue`;

async function hook(prompt?: string): Promise<{ stdout: string; staticHash: string | null }> {
  const { stdout, staticHash } = await buildPromptHookContext(ctx, {
    sessionId: 'sess-1',
    project: PROJECT,
    payload: prompt === undefined ? {} : { prompt },
  });
  return { stdout, staticHash };
}

async function block(prompt?: string): Promise<string> {
  const { stdout } = await hook(prompt);
  return stdout === '' ? '' : JSON.parse(stdout).hookSpecificOutput.additionalContext;
}

describe('the hook block with excludeTags', () => {
  it('backfills the recent rows from untagged ones when seven newer digests are left out', async () => {
    for (let n = 1; n <= 5; n++) writeEntry(local, row(ruleText(n), n, { tags: ['rule'] }));
    for (let n = 1; n <= 7; n++) writeEntry(local, row(digestText(n), 20 + n, { tags: [DIGEST] }));

    writeConfig({ promptRecall: false, excludeTags: [DIGEST] });
    const kept = await block();
    for (let n = 1; n <= 5; n++) expect(kept).toContain(ruleText(n));
    expect(kept).not.toContain('Digest');

    writeConfig({ promptRecall: false });
    const today = await block();
    expect(today).toContain('Digest');
    expect(today).not.toContain(ruleText(1));
  });

  it('leaves out a pinned row that carries a listed tag', async () => {
    writeEntry(local, row(ruleText(1), 1, { pinned: true, tags: ['rule'] }));
    writeEntry(local, row(digestText(1), 2, { pinned: true, tags: [DIGEST] }));

    writeConfig({ promptRecall: false, excludeTags: [DIGEST] });
    const kept = await block();
    expect(kept).toContain(ruleText(1));
    expect(kept).not.toContain(digestText(1));

    writeConfig({ promptRecall: false });
    expect(await block()).toContain(digestText(1));
  });

  it('reads an empty list and an absent key to the same stdout and static hash', async () => {
    writeEntry(local, row(ruleText(1), 1, { pinned: true, tags: ['rule'] }));
    for (let n = 1; n <= 3; n++) writeEntry(local, row(digestText(n), 10 + n, { tags: [DIGEST] }));

    writeConfig({ promptRecall: false });
    const absent = await hook();
    writeConfig({ promptRecall: false, excludeTags: [] });
    const empty = await hook();

    expect(absent.stdout).not.toBe('');
    expect(absent.staticHash).not.toBeNull();
    expect(empty).toEqual(absent);
  });

  it('reads a config built in code without the key as no list, prompt recall on', async () => {
    writeEntry(local, row(ruleText(1), 1, { pinned: true, tags: ['rule'] }));
    writeEntry(
      local,
      row('postgres migration rollback deploy checklist for the billing worker', 2, { tags: [DIGEST] }),
    );

    writeConfig({ promptRecall: true, excludeTags: [] });
    const empty = await hook(PROMPT);
    const { excludeTags: _dropped, ...older } = ctx.config.pinnedInject;
    ctx = { ...ctx, config: { ...ctx.config, pinnedInject: older } };
    const absent = await hook(PROMPT);

    expect(absent.stdout).toContain('billing worker');
    expect(absent).toEqual(empty);
  });
});

describe('prompt recall with excludeTags', () => {
  const RULE =
    'Rule: take a postgres backup before any migration, then keep the rollback and deploy notes ready for review';
  const admit: AmbientAdmission = { currentProject: PROJECT, includeCrossProject: false };
  const recallConfig = { promptRecall: true, promptRecallThreshold: 0.01, promptRecallMinShared: 1 };

  /** The prompt-recall pool the store hands core, as the hook's read asks for it. */
  async function pool(prompt: string, excludeTags?: readonly string[]): Promise<MemoryEntry[]> {
    const got = await ctx.store.contextReads.ambientCandidates(ctx.tenantId, {
      recentNeeded: 0,
      admit: { ...admit, excludeTags },
      recall: { terms: promptSearchTerms(prompt), limit: WINDOW, ...(excludeTags && { excludeTags }) },
    });
    return got.recall ?? [];
  }

  it('cuts excluded matches before the window limit, so a kept match past it still arrives', async () => {
    writeEntry(local, row(RULE, 1, { tags: ['rule'] }));
    seedMany(
      Array.from({ length: 120 }, (_, i) =>
        row(`Digest ${i}: postgres migration rollback deploy checklist`, 10 + i, { tags: [DIGEST] }),
      ),
    );

    const crowded = await pool(PROMPT);
    expect(crowded).toHaveLength(WINDOW);
    expect(crowded.every((e) => e.tags.includes(DIGEST))).toBe(true);

    const filtered = await pool(PROMPT, [DIGEST]);
    expect(filtered.map((e) => e.content)).toEqual([RULE]);

    writeConfig({ ...recallConfig });
    const today = await block(PROMPT);
    expect(today).toContain('Digest');
    expect(today).not.toContain(RULE);

    writeConfig({ ...recallConfig, excludeTags: [DIGEST] });
    const kept = await block(PROMPT);
    expect(kept).toContain(RULE);
    expect(kept).not.toContain('Digest');
  });

  it('keeps an excluded Chinese match out of the trigram arm without a failed-query warning', async () => {
    const kept = '数据库连接池的大小必须设置为二十';
    const left = '数据库连接池的备份摘要记录已经归档';
    writeEntry(local, row(kept, 1, { tags: ['rule'] }));
    writeEntry(local, row(left, 2, { tags: [DIGEST] }));
    const warned = vi.spyOn(log, 'warnThenSample').mockImplementation(() => undefined);
    const prompt = '数据库连接池应该多大';

    writeConfig({ ...recallConfig });
    const today = await block(prompt);
    expect(today).toContain(kept);
    expect(today).toContain(left);

    writeConfig({ ...recallConfig, excludeTags: [DIGEST] });
    const filtered = await block(prompt);
    expect(filtered).toContain(kept);
    expect(filtered).not.toContain(left);
    expect(warned.mock.calls.map(([, message]) => message)).toEqual([]);
  });

  it('falls back to the untagged rows when every match is excluded, and the block holds no excluded row', async () => {
    const unrelated = [
      row('Coffee machine descaling happens on the first Monday', 1),
      row('Lunch orders close at eleven sharp', 2),
    ];
    for (const r of unrelated) writeEntry(local, { ...r, tags: ['rule'] });
    for (let n = 1; n <= 3; n++)
      writeEntry(local, row(`Digest ${n}: postgres migration rollback deploy checklist`, 10 + n, { tags: [DIGEST] }));

    const filtered = await pool(PROMPT, [DIGEST]);
    expect(filtered.map((e) => e.id)).toEqual(unrelated.map((r) => r.id));

    writeConfig({ ...recallConfig, excludeTags: [DIGEST] });
    expect(await block(PROMPT)).not.toContain('Digest');
  });
});

describe('userRulesGet with excludeTags', () => {
  const rule = (n: number, tags: string[]): MemoryEntry =>
    row(`Rule ${n}: keep change note ${n} in its own file`, n, {
      source: 'capture',
      confidence: 'observed',
      pinned: true,
      tags: ['rule', 'captured', USER_RULE_TAG, ...tags],
    });

  it('drops a user rule carrying a listed tag and keeps one that does not', async () => {
    const [stale, fresh] = [rule(1, ['stale-note']), rule(2, [])];
    writeEntry(local, stale);
    writeEntry(local, fresh);

    writeConfig({ excludeTags: ['stale-note'] });
    expect((await userRulesGet(ctx, { currentProject: PROJECT })).map((e) => e.id)).toEqual([fresh.id]);

    writeConfig({});
    expect((await userRulesGet(ctx, { currentProject: PROJECT })).map((e) => e.id)).toEqual([stale.id, fresh.id]);
  });
});
