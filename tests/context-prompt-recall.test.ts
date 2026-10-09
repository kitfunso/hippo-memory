// Z1: recall against the prompt, gated (docs/plans/2026-09-26-z1-prompt-recall.md).
// Real SQLite stores in tmp dirs, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import type { HippoConfig } from '../src/config.js';
import { getContext, type Context } from '../src/api.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { _resetAblationCacheForTests } from '../src/ablation.js';
import { hippoOut } from './_helpers/spawn-hippo.js';

const PROJECT = 'proj-a';

let tmpRoot: string;
let local: string;
let ctx: Context;

function seed(root: string, content: string, extra: Partial<MemoryEntry> = {}) {
  const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), origin_project: PROJECT, ...extra };
  writeEntry(root, entry);
  return entry;
}

function ids(result: { entries: Array<{ entry: { id: string } }> }) {
  return result.entries.map((e) => e.entry.id);
}

function enablePromptRecall(root: string, overrides: Partial<HippoConfig['pinnedInject']> = {}) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    pinnedInject: {
      promptRecall: true,
      promptRecallThreshold: 0.1,
      promptRecallMinShared: 1,
      ...overrides,
    },
  }));
}

beforeEach(() => {
  _resetAblationCacheForTests();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-prompt-recall-'));
  local = path.join(tmpRoot, 'local', '.hippo');
  const globalRoot = path.join(tmpRoot, 'global');
  fs.mkdirSync(local, { recursive: true });
  fs.mkdirSync(globalRoot, { recursive: true });
  initStore(local);
  initStore(globalRoot);
  process.env.HIPPO_HOME = globalRoot;
  ctx = { hippoRoot: local, tenantId: 'default', actor: { subject: 'cli', role: 'admin' } };
});

afterEach(() => {
  delete process.env.HIPPO_HOME;
  _resetAblationCacheForTests();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getContext prompt recall (api-level)', () => {
  it('admits a relevant unpinned memory and marks it, excludes a newer irrelevant one', async () => {
    enablePromptRecall(local);
    const relevant = seed(local, 'the postgres migration script needs a rollback plan before deploy', {
      created: '2026-01-01T00:00:00.000Z',
    });
    seed(local, 'unrelated note about coffee and lunch scheduling for the office', {
      created: '2026-06-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: 'how should the postgres migration rollback plan work',
    });

    const hit = result.entries.find((e) => e.entry.id === relevant.id);
    expect(hit).toBeDefined();
    expect(hit!.promptRecall).toBe(true);
  });

  it('recalls from a store with no pins and no include-recent', async () => {
    enablePromptRecall(local);
    const relevant = seed(local, 'the postgres migration script needs a rollback plan before deploy');

    const result = await getContext(ctx, {
      pinnedOnly: true,
      currentProject: PROJECT,
      prompt: 'how should the postgres migration rollback plan work',
    });

    expect(ids(result)).toEqual([relevant.id]);
  });

  it('is on by default: no config swaps the newest memory for the matching one', async () => {
    const relevant = seed(local, 'the postgres migration script needs a rollback plan before deploy', {
      created: '2026-01-01T00:00:00.000Z',
    });
    seed(local, 'unrelated note about coffee and lunch scheduling for the office', {
      created: '2026-06-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: 'how should the postgres migration rollback plan work',
    });

    expect(fs.existsSync(path.join(local, 'config.json'))).toBe(false);
    expect(ids(result)).toEqual([relevant.id]);
    expect(result.entries[0]!.promptRecall).toBe(true);
  });

  it('treats a non-boolean promptRecall value as off', async () => {
    fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pinnedInject: { promptRecall: 'false' } }));
    seed(local, 'the postgres migration script needs a rollback plan before deploy');

    const result = await getContext(ctx, {
      pinnedOnly: true,
      currentProject: PROJECT,
      prompt: 'how should the postgres migration rollback plan work',
    });

    expect(result.entries).toEqual([]);
  });

  it('floors a fractional candidate limit instead of failing the hook', async () => {
    enablePromptRecall(local, { promptRecallCandidates: 1.5 });
    const relevant = seed(local, 'the postgres migration script needs a rollback plan before deploy');

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: 'how should the postgres migration rollback plan work',
    });

    expect(result.entries.find((e) => e.entry.id === relevant.id)?.promptRecall).toBe(true);
  });

  it('falls back to pins only when nothing clears the gate', async () => {
    enablePromptRecall(local);
    const pin = seed(local, 'the pinned decision that always injects', { pinned: true });
    seed(local, 'a totally unrelated row about gardening tips for tomatoes');

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: 'debugging a kubernetes networking timeout',
    });

    expect(ids(result)).toEqual([pin.id]);
  });

  it('flag off with a prompt present is byte-identical to recent-5', async () => {
    enablePromptRecall(local, { promptRecall: false });
    const rows = Array.from({ length: 5 }, (_, i) =>
      seed(local, `recent row ${i} with enough words to clear the quality floor`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      }),
    );

    const withoutPrompt = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });
    const withPromptFlagOff = await getContext(ctx, {
      pinnedOnly: true, includeRecent: 5, currentProject: PROJECT, prompt: 'irrelevant text here',
    });

    expect(new Set(ids(withPromptFlagOff))).toEqual(new Set(rows.map((r) => r.id)));
    expect(new Set(ids(withPromptFlagOff))).toEqual(new Set(ids(withoutPrompt)));
  });

  it('flag on with no prompt is byte-identical to recent-5', async () => {
    enablePromptRecall(local);
    const rows = Array.from({ length: 5 }, (_, i) =>
      seed(local, `recent row ${i} with enough words to clear the quality floor`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      }),
    );

    const result = await getContext(ctx, { pinnedOnly: true, includeRecent: 5, currentProject: PROJECT });

    expect(new Set(ids(result))).toEqual(new Set(rows.map((r) => r.id)));
  });

  it('never admits a superseded, secret-flagged, cross-project, or pinned row as prompt-recall', async () => {
    enablePromptRecall(local);
    const superseded = seed(local, 'the superseded database indexing plan for the migration', {
      superseded_by: 'some-newer-id',
    });
    const secret = seed(local, 'the migration database password is on the indexing plan doc', {
      tags: ['secret'], origin_project: 'proj-b',
    });
    const crossProject = seed(local, 'a different project migration database indexing plan note', {
      origin_project: 'proj-b',
    });
    const pinned = seed(local, 'pinned migration database indexing plan already always injected', {
      pinned: true,
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: 'migration database indexing plan',
    });

    const recallIds = result.entries.filter((e) => e.promptRecall).map((e) => e.entry.id);
    expect(recallIds).not.toContain(superseded.id);
    expect(recallIds).not.toContain(secret.id);
    expect(recallIds).not.toContain(crossProject.id);
    expect(recallIds).not.toContain(pinned.id);
  });

  it('finds a relevant memory via rarest-term pre-select even when its terms are not first in the prompt', async () => {
    // maxItems raised past the decoy count: they share more prompt tokens than the
    // target (that's the point -- FTS pre-select is under test, not the overlap gate).
    enablePromptRecall(local, { promptRecallMinShared: 1, promptRecallThreshold: 0.05, promptRecallMaxItems: 20 });
    // 8 decoys share every common word (FTS doc count 8 each); a naive
    // first-8-terms query would never include needle/fingerprint, which
    // appear in exactly one row (doc count 1) and come last in the prompt.
    const commonWords = 'alpha bravo charlie delta echo foxtrot golf hotel';
    for (let i = 0; i < 8; i++) {
      seed(local, `${commonWords} decoy row number ${i} about something else entirely`, {
        created: new Date(Date.UTC(2026, 5, 1, 0, i)).toISOString(),
      });
    }
    const relevant = seed(local, 'needle fingerprint distinctive marker for the migration plan', {
      created: '2026-01-01T00:00:00.000Z',
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      prompt: `${commonWords} needle fingerprint`,
    });

    const hit = result.entries.find((e) => e.entry.id === relevant.id);
    expect(hit).toBeDefined();
    expect(hit!.promptRecall).toBe(true);
  });

  it('skips an over-budget candidate without blocking a smaller one behind it (skip-not-break)', async () => {
    enablePromptRecall(local, { promptRecallMaxItems: 2 });
    // Same distinct content-token set as `small` (repetition adds no new
    // tokens), so both tie on score and the id tie-break puts `big` first.
    const shared = 'deploy rollback plan for service payments-api2026';
    const big = seed(local, (shared + ' ').repeat(50), {
      id: 'aaa-big', created: '2026-01-01T00:00:00.000Z',
    });
    const small = seed(local, shared, {
      id: 'bbb-small', created: '2026-01-02T00:00:00.000Z',
    });

    const result = await getContext(ctx, {
      pinnedOnly: true,
      includeRecent: 5,
      currentProject: PROJECT,
      budget: 60,
      prompt: shared,
    });

    const recallIds = result.entries.filter((e) => e.promptRecall).map((e) => e.entry.id);
    expect(recallIds).not.toContain(big.id);
    expect(recallIds).toContain(small.id);
  });
});

describe('hippo context --pinned-only --format additional-context prompt recall (CLI-level)', () => {
  let hippoDir: string;
  let cliTmp: string;
  let globalDir: string;

  beforeEach(() => {
    cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-prompt-recall-cli-'));
    hippoDir = path.join(cliTmp, '.hippo');
    globalDir = path.join(cliTmp, 'global');
    fs.mkdirSync(hippoDir, { recursive: true });
    initStore(hippoDir);
    enablePromptRecall(hippoDir);
  });

  afterEach(() => {
    fs.rmSync(cliTmp, { recursive: true, force: true });
  });

  // No origin_project override: the CLI derives it from cwd's own basename,
  // so a hardcoded 'proj-a' (unlike the api-level tests, which pin currentProject to match) would read as cross-project and get excluded.
  function seedCli(content: string, extra: Partial<MemoryEntry> = {}) {
    const entry = { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
    writeEntry(hippoDir, entry);
    return entry;
  }

  function runHippo(args: string[], stdin: string): string {
    return hippoOut(args, { env: { ...process.env, HIPPO_HOME: globalDir }, cwd: cliTmp, input: stdin });
  }

  it('emits a static section and a Prompt-Relevant Memory section, with a hook_recall ledger row', () => {
    seedCli('the deploy rollback plan for the postgres migration', { created: '2026-01-01T00:00:00.000Z' });
    seedCli('PINNED: always check the rollback plan before deploy', { pinned: true });

    const sessionId = 'sess-z1-cli-1';
    const out = runHippo(
      ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'],
      JSON.stringify({ session_id: sessionId, prompt: 'postgres migration rollback plan' }),
    );
    const parsed = JSON.parse(out);
    const context: string = parsed.hookSpecificOutput.additionalContext;
    expect(context).toContain('PINNED: always check the rollback plan');
    expect(context).toContain('## Prompt-Relevant Memory');
    expect(context).toContain('the deploy rollback plan for the postgres migration');

    const db = openHippoDb(hippoDir);
    try {
      // SAFETY: COUNT(*) AS n always yields one row with a numeric n.
      const row = db.prepare(
        `SELECT COUNT(*) AS n FROM token_ledger WHERE session_id = ? AND surface = 'hook_recall' AND event = 'inject'`,
      ).get(sessionId) as { n: number };
      expect(Number(row.n)).toBe(1);
    } finally {
      closeHippoDb(db);
    }
  });

  it('skips the repeated static block but still emits a relevant recall section', () => {
    seedCli('the deploy rollback plan for the postgres migration', { created: '2026-01-01T00:00:00.000Z' });
    seedCli('PINNED: always check the rollback plan before deploy', { pinned: true });

    const sessionId = 'sess-z1-cli-2';
    const payload = JSON.stringify({ session_id: sessionId, prompt: 'postgres migration rollback plan' });
    const first = runHippo(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'], payload);
    expect(JSON.parse(first).hookSpecificOutput.additionalContext).toContain('PINNED: always check the rollback plan');

    const second = runHippo(['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'], payload);
    const context: string = JSON.parse(second).hookSpecificOutput.additionalContext;
    expect(context).not.toContain('PINNED: always check the rollback plan');
    expect(context).toContain('## Prompt-Relevant Memory');
    expect(context).toContain('the deploy rollback plan for the postgres migration');
  });

  it('keeps a cross-project recall in the always-sent section on a repeated prompt', () => {
    seedCli('the deploy rollback plan for the postgres migration', { origin_project: 'some-other-project' });
    seedCli('PINNED: always check the rollback plan before deploy', { pinned: true });

    const payload = JSON.stringify({ session_id: 'sess-z1-cli-x', prompt: 'postgres migration rollback plan' });
    const args = ['context', '--pinned-only', '--include-recent', '5', '--cross-project', '--format', 'additional-context'];
    runHippo(args, payload);
    const context: string = JSON.parse(runHippo(args, payload)).hookSpecificOutput.additionalContext;
    expect(context).toContain('## Prompt-Relevant Memory');
    expect(context).toContain('the deploy rollback plan for the postgres migration');
  });

  it('malformed stdin still works exactly as today (no crash, graceful fallback)', () => {
    seedCli('PINNED: this must still render on malformed stdin', { pinned: true });

    const out = runHippo(['context', '--pinned-only', '--format', 'additional-context'], 'not json');
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.additionalContext).toContain('PINNED: this must still render on malformed stdin');
  });
});
