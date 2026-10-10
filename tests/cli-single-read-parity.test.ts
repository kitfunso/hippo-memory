// Pins what `forget --dry-run`, `resolve` (no --keep), `inspect`, `share` and `trace <id>` print and leave on the built CLI with no server,
// so reading their one memory through the api cannot change a byte, an exit code or a row. `decide --supersedes` and `supersede` are pinned
// in cli-maintenance-writes-parity and cli-write-verbs-parity. What a snapshot masks is listed in tests/_helpers/cli-parity-store.ts.
import { describe, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type CreateMemoryOptions, type MemoryEntry } from '../src/core/memory.js';
import { replaceDetectedConflicts } from '../src/store/conflicts.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { Store } from './_helpers/cli-parity-store.js';

const CASE_MS = 180_000;
const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const CREATED = '2026-01-20T00:00:00.000Z';
const CLEAN = 'the billing service retries a failed charge three times';
const LONG = `${CLEAN}; ${'the invoice worker sends a receipt after each charge and logs the charge id; '.repeat(3)}end`;
const MISSING = 'mem_does_not_exist';

/** A store on the fixed clock, so ages and decayed strengths print the same on every run. */
function clocked(opts: { global?: boolean } = {}): Store {
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
function runOnUnreadableStore(s: Store, ...args: string[]): void {
  const file = join(s.root, 'hippo.db');
  const bytes = readFileSync(file);
  writeFileSync(file, 'these bytes are not a database');
  try {
    s.run(...args);
  } finally {
    writeFileSync(file, bytes);
  }
}

describe('hippo forget --dry-run (built CLI, no server)', () => {
  it('previews a row, with its text cut at the preview length', () => {
    const s = new Store();
    const short = s.seed(CLEAN, { tags: ['billing'] });
    const long = s.seed(LONG);
    s.settle();
    s.run('forget', short, '--dry-run');
    s.run('forget', long, '--dry-run');
    s.expectPinned();
  }, CASE_MS);

  it('refuses a raw row, and --archive refuses a row that is not raw', () => {
    const s = new Store();
    const raw = s.seed('raw slack message about the billing retry count', { kind: 'raw' });
    const plain = s.seed(CLEAN);
    s.settle();
    s.run('forget', raw, '--dry-run');
    s.run('forget', raw, '--dry-run', '--archive', '--reason', 'asked to remove it');
    s.run('forget', plain, '--dry-run', '--archive', '--reason', 'asked to remove it');
    s.expectPinned();
  }, CASE_MS);

  it('an unknown id, a row of another tenant, and a store that cannot be read', () => {
    const s = new Store();
    const other = s.seed(CLEAN, { tenantId: 'other' });
    s.settle();
    s.run('forget', MISSING, '--dry-run');
    s.run('forget', other, '--dry-run');
    runOnUnreadableStore(s, 'forget', other, '--dry-run');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo resolve with no --keep (built CLI, no server)', () => {
  const NOW = '2026-01-25T00:00:00.000Z';
  // Fixed ids: the store orders a conflict's two sides by id, so random ids would swap [A] and [B] between runs.
  const A = 'mem_resolve_a';
  const B = 'mem_resolve_b';

  it('shows both sides of an open conflict, each cut at the preview length', () => {
    const s = new Store();
    s.seedAged(A, CREATED, CLEAN);
    s.seedAged(B, CREATED, LONG);
    replaceDetectedConflicts(s.root, [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }], NOW);
    s.settle();
    s.run('resolve', '1');
    s.run('resolve', 'conflict_1');
    s.expectPinned();
  }, CASE_MS);

  it('an unknown conflict, a conflict of another tenant, and a store that cannot be read', () => {
    const s = new Store();
    s.seedAged(A, CREATED, CLEAN, { tenantId: 'other' });
    s.seedAged(B, CREATED, LONG, { tenantId: 'other' });
    replaceDetectedConflicts(s.root, [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }], NOW);
    s.settle();
    s.run('resolve', '7');
    s.run('resolve', '1');
    runOnUnreadableStore(s, 'resolve', '1');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo inspect (built CLI, no server)', () => {
  it('prints a plain row, and a row with outcomes, tags and a conflict', () => {
    const s = clocked();
    s.seedAged('mem_inspect_plain', CREATED, CLEAN);
    s.seedAged('mem_inspect_full', CREATED, LONG, { tags: ['billing', 'error'], pinned: true }, {
      outcome_positive: 2, outcome_negative: 1, conflicts_with: ['mem_inspect_plain'], retrieval_count: 4,
    });
    s.settle();
    s.run('inspect', 'mem_inspect_plain');
    s.run('inspect', 'mem_inspect_full');
    s.expectPinned();
  }, CASE_MS);

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', () => {
    const s = clocked();
    s.seedAged('mem_inspect_other', CREATED, CLEAN, { tenantId: 'other' });
    s.settle();
    s.run('inspect', MISSING);
    s.run('inspect', 'mem_inspect_other');
    s.run('inspect');
    runOnUnreadableStore(s, 'inspect', 'mem_inspect_other');
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo share (built CLI, no server)', () => {
  it('a row whose transfer score is too low is not shared', () => {
    const s = new Store({ global: true });
    const id = s.seed('the deploy cron reads its endpoint from config', { tags: ['deploy', 'cron', 'config'] });
    s.settle();
    s.run('share', id);
    s.expectPinned();
  }, CASE_MS);

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', () => {
    const s = new Store({ global: true });
    const other = s.seed('the deploy cron reads its endpoint from config', { tags: ['deploy', 'cron', 'config'], tenantId: 'other' });
    s.settle();
    s.run('share', MISSING);
    s.run('share', other);
    s.run('share');
    runOnUnreadableStore(s, 'share', other);
    s.expectPinned();
  }, CASE_MS);
});

describe('hippo trace <id> (built CLI, no server)', () => {
  it('a local row with a local parent, a global parent and a missing one, as text and as json', () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_parent', CREATED, LONG);
    seedGlobal(s, 'mem_trace_gparent', 'a parent that only the global store holds');
    s.seedAged('mem_trace_child', CREATED, CLEAN, { tags: ['billing'] }, { parents: ['mem_trace_parent', 'mem_trace_gparent', MISSING] });
    s.settle();
    s.run('trace', 'mem_trace_child');
    s.run('trace', 'mem_trace_child', '--json');
    s.run('trace', 'mem_trace_parent');
    s.expectPinned();
  }, CASE_MS);

  it('a row only the global store holds, and a parent of another tenant reads as not found', () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_hidden', CREATED, LONG, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_global', CLEAN, {}, { parents: ['mem_trace_hidden'] });
    s.settle();
    s.run('trace', 'mem_trace_global');
    s.expectPinned();
  }, CASE_MS);

  it('an unknown id with and without a global store, a row of another tenant, and a store that cannot be read', () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_other', CREATED, CLEAN, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_gother', CLEAN, { tenantId: 'other' });
    s.settle();
    s.run('trace', MISSING);
    s.run('trace', 'mem_trace_other');
    s.run('trace', 'mem_trace_gother');
    runOnUnreadableStore(s, 'trace', 'mem_trace_other');
    const bare = clocked();
    bare.run('trace', MISSING);
    s.expectPinned();
    bare.expectPinned();
  }, CASE_MS);
});
