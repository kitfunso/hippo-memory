// A session's own compaction items never inject back into it; another session and explicit recall still see them.
// Real SQLite stores in tmp dirs, no mocks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  COMPACTION_MEMORY_TAG,
  COMPACTION_SOURCE_PREFIX,
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type MemoryEntry,
} from '../src/memory.js';
import { initStore, writeEntry } from '../src/store.js';
import { getContext, recall, type Context } from '../src/api.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';

const PROJECT = 'proj-a';
const OWN = 'sess-own';
const OTHER = 'sess-other';
const HIPPO_JS = resolve(__dirname, '..', 'bin', 'hippo.js');

let tmpRoot: string;
let local: string;
let ctx: Context;

const minute = (base: number, i: number): string => new Date(Date.UTC(2026, base, 1, 0, i)).toISOString();

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: PROJECT, ...extra };
  writeEntry(root, entry);
  return entry;
}

function seedItem(root: string, sessionId: string, content: string, created: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return seed(root, content, {
    tags: [COMPACTION_MEMORY_TAG],
    source: `${COMPACTION_SOURCE_PREFIX}${sessionId}`,
    source_session_id: sessionId,
    created,
    ...extra,
  });
}

const ids = (result: { entries: Array<{ entry: { id: string } }> }): string[] => result.entries.map((e) => e.entry.id);

function enablePromptRecall(root: string): void {
  writeFileSync(join(root, 'config.json'), JSON.stringify({
    pinnedInject: { promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1, promptRecallMaxItems: 10 },
  }));
}

beforeEach(() => {
  _resetAblationCacheForTests();
  tmpRoot = mkdtempSync(join(tmpdir(), 'hippo-own-session-'));
  local = join(tmpRoot, 'local', '.hippo');
  const globalRoot = join(tmpRoot, 'global');
  mkdirSync(local, { recursive: true });
  mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  vi.stubEnv('HIPPO_HOME', globalRoot);
  ctx = { hippoRoot: local, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('own-session compaction items in recent context', () => {
  // 40 items outnumber the loader's first window (32), so admit has to reject them for the load to widen.
  function seedFortyItemsAndOlderRows() {
    const older = Array.from({ length: 8 }, (_, i) =>
      seed(local, `older release note ${i} about the checklist for the payments service`, { created: minute(0, i) }));
    const items = Array.from({ length: 40 }, (_, i) =>
      seedItem(local, OWN, `compaction item ${i} says the deploy job must run the migration check before it ships`, minute(5, i)));
    return { items, older };
  }

  it('fills the recent slots with older rows instead of the session own items', async () => {
    const { older } = seedFortyItemsAndOlderRows();

    const result = await getContext(ctx, {
      pinnedOnly: true, includeRecent: 5, budget: 2000, currentProject: PROJECT, currentSessionId: OWN,
    });

    const newestOlder = [...older].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 5).map((e) => e.id);
    expect(ids(result).sort()).toEqual(newestOlder.sort());
    expect(result.entries.some((e) => e.entry.tags.includes(COMPACTION_MEMORY_TAG))).toBe(false);
  });

  it('shows the same items to a different session, and to a caller with no session id', async () => {
    const { items } = seedFortyItemsAndOlderRows();
    const newestItems = [...items].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 5).map((e) => e.id).sort();

    for (const currentSessionId of [OTHER, '', null, undefined]) {
      const result = await getContext(ctx, {
        pinnedOnly: true, includeRecent: 5, budget: 2000, currentProject: PROJECT, currentSessionId,
      });
      expect(ids(result).sort()).toEqual(newestItems);
    }
  });

  it('keeps them out of the strength-ranked context too', async () => {
    const { older } = seedFortyItemsAndOlderRows();

    const result = await getContext(ctx, { budget: 2000, currentProject: PROJECT, currentSessionId: OWN });

    expect(ids(result).sort()).toEqual(older.map((e) => e.id).sort());
  });

  it('keeps an untagged row from the same session', async () => {
    const plain = seed(local, 'a plain note from the same session about the deploy migration check', {
      source_session_id: OWN, created: minute(6, 0),
    });

    const result = await getContext(ctx, {
      pinnedOnly: true, includeRecent: 5, budget: 2000, currentProject: PROJECT, currentSessionId: OWN,
    });

    expect(ids(result)).toEqual([plain.id]);
  });
});

describe('own-session compaction items under prompt recall', () => {
  const prompt = 'how should the postgres migration rollback plan work';

  function seedRecallRows() {
    const older = seed(local, 'the postgres migration script needs a rollback plan before deploy', { created: minute(0, 0) });
    const items = ['first', 'second', 'third'].map((word, i) =>
      seedItem(local, OWN, `the ${word} lesson from this session is that the postgres migration rollback plan needs a dry run`, minute(5, i)));
    return { items, older };
  }

  it('injects none of the session own items, only the older relevant row', async () => {
    enablePromptRecall(local);
    const { older } = seedRecallRows();

    const result = await getContext(ctx, { pinnedOnly: true, currentProject: PROJECT, currentSessionId: OWN, prompt });

    expect(ids(result)).toEqual([older.id]);
    expect(result.entries[0]?.promptRecall).toBe(true);
  });

  it('injects them for a different session', async () => {
    enablePromptRecall(local);
    const { items, older } = seedRecallRows();

    const result = await getContext(ctx, { pinnedOnly: true, currentProject: PROJECT, currentSessionId: OTHER, prompt });

    expect(ids(result).sort()).toEqual([older.id, ...items.map((e) => e.id)].sort());
    expect(result.entries.every((e) => e.promptRecall === true)).toBe(true);
  });
});

describe('explicit recall is not filtered', () => {
  function seedThree(root: string): string[] {
    return ['alpha', 'beta', 'gamma'].map((word, i) =>
      seedItem(root, OWN, `the ${word} lesson from this session is that the ledger export needs a dry run`, minute(5, i)).id);
  }

  it('api recall returns the session own items', () => {
    const wanted = seedThree(local);

    const result = recall(ctx, { query: 'ledger export dry run' });

    expect(result.results.map((r) => r.id).sort()).toEqual(wanted.sort());
  });

  it('hippo recall returns them even when the calling session id is the items own', () => {
    const cliTmp = mkdtempSync(join(tmpdir(), 'hippo-own-session-cli-'));
    try {
      const store = join(cliTmp, '.hippo');
      mkdirSync(store, { recursive: true });
      initStore(store);
      const wanted = seedThree(store);

      const out = execFileSync(process.execPath, [HIPPO_JS, 'recall', 'ledger export dry run', '--json'], {
        env: { ...process.env, HIPPO_HOME: join(cliTmp, 'global'), HIPPO_SESSION_ID: OWN },
        cwd: cliTmp,
        input: JSON.stringify({ session_id: OWN }),
        encoding: 'utf8',
      });

      // SAFETY: `hippo recall --json` prints one object whose results each carry an id.
      const found = (JSON.parse(out) as { results: Array<{ id: string }> }).results.map((r) => r.id);
      expect(found.sort()).toEqual(wanted.sort());
    } finally {
      rmSync(cliTmp, { recursive: true, force: true });
    }
  });
});
