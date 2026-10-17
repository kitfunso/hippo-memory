// Pins what `forget --dry-run`, `resolve` (no --keep), `inspect`, `share` and `trace <id>` print and leave with no server,
// so reading their one memory through the api cannot change a byte, an exit code or a row. `decide --supersedes` and `supersede` are pinned
// in cli-maintenance-writes-parity and cli-write-verbs-parity. What a snapshot masks is listed in tests/_helpers/cli-parity-store.ts.
// The first case of each verb spawns the built CLI; the rest run it in process.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from '../src/core/memory.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { Store } from './_helpers/cli-parity-store.js';

const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const CREATED = '2026-01-20T00:00:00.000Z';
const CLEAN = 'the billing service retries a failed charge three times';
const LONG = `${CLEAN}; ${'the invoice worker sends a receipt after each charge and logs the charge id; '.repeat(3)}end`;
const MISSING = 'mem_does_not_exist';

/** A store on the fixed clock, so ages and decayed strengths print the same on every run. */
function clocked(opts: { global?: boolean; spawned?: boolean } = {}): Store {
  const s = new Store(opts);
  s.env['HIPPO_FAKE_NOW'] = FAKE_NOW;
  return s;
}

/** A row in the global store, which `Store.seedAged` does not reach. */
function seedGlobal(s: Store, id: string, content: string, options: Partial<CreateMemoryOptions> = {}, fields: Partial<MemoryEntry> = {}): void {
  const made = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options });
  writeEntry(s.home, { ...made, id, created: CREATED, last_retrieved: CREATED, valid_from: CREATED, strength: 1, ...fields });
}

/** Runs `args` while hippo.db holds bytes SQLite cannot open, then puts the store back so its rows can be pinned. */
async function runOnUnreadableStore(s: Store, ...args: string[]): Promise<void> {
  const file = join(s.root, 'hippo.db');
  const bytes = readFileSync(file);
  writeFileSync(file, 'these bytes are not a database');
  try {
    await s.run(...args);
  } finally {
    writeFileSync(file, bytes);
  }
}

describe('hippo forget --dry-run (built CLI, no server)', () => {
  it('previews a row, with its text cut at the preview length', async () => {
    const s = new Store({ spawned: true });
    const short = s.seed(CLEAN, { tags: ['billing'] });
    const long = s.seed(LONG);
    s.settle();
    await s.run('forget', short, '--dry-run');
    await s.run('forget', long, '--dry-run');
    s.expectPinned();
  });

  it('refuses a raw row, and --archive refuses a row that is not raw', async () => {
    const s = new Store();
    const raw = s.seed('raw slack message about the billing retry count', { kind: 'raw' });
    const plain = s.seed(CLEAN);
    s.settle();
    await s.run('forget', raw, '--dry-run');
    await s.run('forget', raw, '--dry-run', '--archive', '--reason', 'asked to remove it');
    await s.run('forget', plain, '--dry-run', '--archive', '--reason', 'asked to remove it');
    s.expectPinned();
  });

  it('an unknown id, a row of another tenant, and a store that cannot be read', async () => {
    const s = new Store();
    const other = s.seed(CLEAN, { tenantId: 'other' });
    s.settle();
    await s.run('forget', MISSING, '--dry-run');
    await s.run('forget', other, '--dry-run');
    await runOnUnreadableStore(s, 'forget', other, '--dry-run');
    s.expectPinned();
  });
});

describe('hippo resolve with no --keep (built CLI, no server)', () => {
  const NOW = '2026-01-25T00:00:00.000Z';
  // Fixed ids: the store orders a conflict's two sides by id, so random ids would swap [A] and [B] between runs.
  const A = 'mem_resolve_a';
  const B = 'mem_resolve_b';

  it('shows both sides of an open conflict, each cut at the preview length', async () => {
    const s = new Store({ spawned: true });
    s.seedAged(A, CREATED, CLEAN);
    s.seedAged(B, CREATED, LONG);
    replaceDetectedConflicts(s.root, [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }], NOW);
    s.settle();
    await s.run('resolve', '1');
    await s.run('resolve', 'conflict_1');
    s.expectPinned();
  });

  it('an unknown conflict, a conflict of another tenant, and a store that cannot be read', async () => {
    const s = new Store();
    s.seedAged(A, CREATED, CLEAN, { tenantId: 'other' });
    s.seedAged(B, CREATED, LONG, { tenantId: 'other' });
    replaceDetectedConflicts(s.root, [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }], NOW);
    s.settle();
    await s.run('resolve', '7');
    await s.run('resolve', '1');
    await runOnUnreadableStore(s, 'resolve', '1');
    s.expectPinned();
  });
});

describe('hippo inspect (built CLI, no server)', () => {
  it('prints a plain row, and a row with outcomes, tags and a conflict', async () => {
    const s = clocked({ spawned: true });
    s.seedAged('mem_inspect_plain', CREATED, CLEAN);
    s.seedAged('mem_inspect_full', CREATED, LONG, { tags: ['billing', 'error'], pinned: true }, {
      outcome_positive: 2, outcome_negative: 1, conflicts_with: ['mem_inspect_plain'], retrieval_count: 4,
    });
    s.settle();
    await s.run('inspect', 'mem_inspect_plain');
    await s.run('inspect', 'mem_inspect_full');
    s.expectPinned();
  });

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', async () => {
    const s = clocked();
    s.seedAged('mem_inspect_other', CREATED, CLEAN, { tenantId: 'other' });
    s.settle();
    await s.run('inspect', MISSING);
    await s.run('inspect', 'mem_inspect_other');
    await s.run('inspect');
    await runOnUnreadableStore(s, 'inspect', 'mem_inspect_other');
    s.expectPinned();
  });
});

describe('hippo share (built CLI, no server)', () => {
  it('a row whose transfer score is too low is not shared', async () => {
    const s = new Store({ global: true, spawned: true });
    const id = s.seed('the deploy cron reads its endpoint from config', { tags: ['deploy', 'cron', 'config'] });
    s.settle();
    await s.run('share', id);
    s.expectPinned();
  });

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', async () => {
    const s = new Store({ global: true });
    const other = s.seed('the deploy cron reads its endpoint from config', { tags: ['deploy', 'cron', 'config'], tenantId: 'other' });
    s.settle();
    await s.run('share', MISSING);
    await s.run('share', other);
    await s.run('share');
    await runOnUnreadableStore(s, 'share', other);
    s.expectPinned();
  });
});

describe('hippo trace <id> (built CLI, no server)', () => {
  it('a local row with a local parent, a global parent and a missing one, as text and as json', async () => {
    const s = clocked({ global: true, spawned: true });
    s.seedAged('mem_trace_parent', CREATED, LONG);
    seedGlobal(s, 'mem_trace_gparent', 'a parent that only the global store holds');
    s.seedAged('mem_trace_child', CREATED, CLEAN, { tags: ['billing'] }, { parents: ['mem_trace_parent', 'mem_trace_gparent', MISSING] });
    s.settle();
    await s.run('trace', 'mem_trace_child');
    await s.run('trace', 'mem_trace_child', '--json');
    await s.run('trace', 'mem_trace_parent');
    s.expectPinned();
  });

  it('a row only the global store holds, and a parent of another tenant reads as not found', async () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_hidden', CREATED, LONG, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_global', CLEAN, {}, { parents: ['mem_trace_hidden'] });
    s.settle();
    await s.run('trace', 'mem_trace_global');
    s.expectPinned();
  });

  it('an unknown id with and without a global store, a row of another tenant, and a store that cannot be read', async () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_other', CREATED, CLEAN, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_gother', CLEAN, { tenantId: 'other' });
    s.settle();
    await s.run('trace', MISSING);
    await s.run('trace', 'mem_trace_other');
    await s.run('trace', 'mem_trace_gother');
    await runOnUnreadableStore(s, 'trace', 'mem_trace_other');
    const bare = clocked();
    await bare.run('trace', MISSING);
    s.expectPinned();
    bare.expectPinned();
  });
});
