// What `forget --dry-run`, `resolve` (no --keep), `inspect`, `share` and `trace <id>` print with no server, and that
// each leaves the store as it was. The first case of each verb spawns the built CLI; the rest run it in process.
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createMemory,
  DEFAULT_HALF_LIFE_DAYS,
  type CreateMemoryOptions,
  type MemoryEntry,
} from '../../src/base/memory/memory.js';
import { Store, type Ran } from '../_helpers/cli-verb-store.js';
import { replaceDetectedConflicts, writeEntry } from '../_helpers/root-forms.js';

const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const CREATED = '2026-01-20T00:00:00.000Z';
const CLEAN = 'the billing service retries a failed charge three times';
const LONG = `${CLEAN}; ${'the invoice worker sends a receipt after each charge and logs the charge id; '.repeat(3)}end`;
const MISSING = 'mem_does_not_exist';
const UNREADABLE: Ran = { status: 1, stdout: '', stderr: 'Error: file is not a database\n' };

const refused = (stderr: string): Ran => ({ status: 1, stdout: '', stderr: `${stderr}\n` });
const printed = (stdout: string): Ran => ({ status: 0, stdout, stderr: '' });

/** A store on the fixed clock, so ages and decayed strengths print the same on every run. */
function clocked(opts: { global?: boolean; spawned?: boolean } = {}): Store {
  const s = new Store(opts);
  s.env['HIPPO_FAKE_NOW'] = FAKE_NOW;
  return s;
}

/** A row in the global store, which `Store.seedAged` does not reach. */
function seedGlobal(
  s: Store,
  id: string,
  content: string,
  options: Partial<CreateMemoryOptions> = {},
  fields: Partial<MemoryEntry> = {},
): void {
  const made = createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...options });
  writeEntry(s.home, {
    ...made,
    id,
    created: CREATED,
    lastRetrieved: CREATED,
    validFrom: CREATED,
    strength: 1,
    ...fields,
  });
}

/** Runs `args` while hippo.db holds bytes SQLite cannot open, then puts the store back. */
async function runOnUnreadableStore(s: Store, ...args: string[]): Promise<Ran> {
  const file = join(s.root, 'hippo.db');
  const bytes = readFileSync(file);
  writeFileSync(file, 'these bytes are not a database');
  try {
    return await s.run(...args);
  } finally {
    writeFileSync(file, bytes);
  }
}

/** Both stores' rows and the global audit rows, read once the case has seeded them. */
function held(s: Store): unknown[] {
  return [s.rows(), s.rows('global'), s.audit('global')];
}

/** A read verb leaves every row, audit row and counter as it found them. */
function expectUntouched(s: Store, before: unknown[]): void {
  expect(held(s)).toEqual(before);
  expect(s.audit()).toEqual([]);
  expect(s.counters()).toEqual({ total_forgotten: '0', total_remembered: '0' });
}

describe('hippo forget --dry-run (built CLI, no server)', () => {
  it('previews a row, with its text cut at the preview length', async () => {
    const s = new Store({ spawned: true });
    const short = s.seed(CLEAN, { tags: ['billing'] });
    const long = s.seed(LONG);
    s.settle();
    const before = held(s);
    const would = (id: string, text: string): Ran =>
      printed(`Would forget ${id} (dry run, nothing changed): "${text}"\n`);
    expect(await s.run('forget', short, '--dry-run')).toEqual(would(short, CLEAN));
    expect(await s.run('forget', long, '--dry-run')).toEqual(would(long, `${LONG.slice(0, 80)}...`));
    expectUntouched(s, before);
  });

  it('refuses a raw row, and --archive refuses a row that is not raw', async () => {
    const s = new Store();
    const raw = s.seed('raw slack message about the billing retry count', { kind: 'raw' });
    const plain = s.seed(CLEAN);
    s.settle();
    const before = held(s);
    expect(await s.run('forget', raw, '--dry-run')).toEqual(
      refused(
        `Cannot forget ${raw}: it is a raw, append-only memory. Archive it instead: hippo forget ${raw} --archive --reason "<why>"`,
      ),
    );
    expect(await s.run('forget', raw, '--dry-run', '--archive', '--reason', 'asked to remove it')).toEqual(
      printed(`Would archive ${raw} (dry run, nothing changed): "raw slack message about the billing retry count"\n`),
    );
    expect(await s.run('forget', plain, '--dry-run', '--archive', '--reason', 'asked to remove it')).toEqual(
      refused(`Could not archive ${plain}: memory ${plain} is not raw (kind=distilled)`),
    );
    expectUntouched(s, before);
  });

  it('an unknown id, a row of another tenant, and a store that cannot be read', async () => {
    const s = new Store();
    const other = s.seed(CLEAN, { tenantId: 'other' });
    s.settle();
    const before = held(s);
    expect(await s.run('forget', MISSING, '--dry-run')).toEqual(refused(`Memory not found: ${MISSING}`));
    expect(await s.run('forget', other, '--dry-run')).toEqual(refused(`Memory not found: ${other}`));
    expect(await runOnUnreadableStore(s, 'forget', other, '--dry-run')).toEqual(UNREADABLE);
    expectUntouched(s, before);
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
    replaceDetectedConflicts(
      s.root,
      [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }],
      NOW,
    );
    s.settle();
    const before = held(s);
    const shown = printed(
      [
        'Conflict 1:',
        `  ${A} <-> ${B}`,
        '  Reason: retry counts differ',
        '',
        `  [A] ${A}:`,
        `      ${CLEAN}`,
        `  [B] ${B}:`,
        `      ${LONG.slice(0, 120)}...`,
        '',
        'Resolve with: hippo resolve 1 --keep <memory_id> [--forget] [--reject-loser [--reason "<why>"]]',
        '',
      ].join('\n'),
    );
    expect(await s.run('resolve', '1')).toEqual(shown);
    expect(await s.run('resolve', 'conflict_1')).toEqual(shown);
    expect(s.rows().map((r) => r['conflicts_with'])).toEqual([[B], [A]]);
    expectUntouched(s, before);
  });

  it('an unknown conflict, a conflict of another tenant, and a store that cannot be read', async () => {
    const s = new Store();
    s.seedAged(A, CREATED, CLEAN, { tenantId: 'other' });
    s.seedAged(B, CREATED, LONG, { tenantId: 'other' });
    replaceDetectedConflicts(
      s.root,
      [{ memory_a_id: A, memory_b_id: B, reason: 'retry counts differ', score: 0.8 }],
      NOW,
    );
    s.settle();
    const before = held(s);
    expect(await s.run('resolve', '7')).toEqual(refused('Conflict 7 not found or already resolved.'));
    expect(await s.run('resolve', '1')).toEqual(refused('Conflict 1 not found or already resolved.'));
    expect(await runOnUnreadableStore(s, 'resolve', '1')).toEqual(UNREADABLE);
    expectUntouched(s, before);
  });
});

describe('hippo inspect (built CLI, no server)', () => {
  /** What inspect prints for a row seeded at CREATED, 12 days before the fixed clock. */
  const inspected = (id: string, fields: Record<string, string>, content: string): Ran =>
    printed(
      [
        `Memory: ${id}`,
        '---------------------------',
        'Layer:            episodic',
        'Confidence:       verified',
        'Created:          <ts> (12.0d ago)',
        'Last retrieved:   <ts> (12.0d ago)',
        ...Object.entries(fields).map(([label, value]) => `${`${label}:`.padEnd(18)}${value}`),
        '',
        'Content:',
        '----------------------------------------',
        content,
        '',
      ].join('\n'),
    );

  it('prints a plain row, and a row with outcomes, tags and a conflict', async () => {
    const s = clocked({ spawned: true });
    s.seedAged('mem_inspect_plain', CREATED, CLEAN);
    s.seedAged(
      'mem_inspect_full',
      CREATED,
      LONG,
      { tags: ['billing', 'error'], pinned: true },
      {
        outcomePositive: 2,
        outcomeNegative: 1,
        conflictsWith: ['mem_inspect_plain'],
        retrievalCount: 4,
      },
    );
    s.settle();
    const before = held(s);
    expect(await s.run('inspect', 'mem_inspect_plain')).toEqual(
      inspected(
        'mem_inspect_plain',
        {
          'Retrieval count': '0',
          'Strength (live)': '0.98 (stored: 1.00)',
          'Half-life': '365d',
          Emotional: 'neutral',
          'Schema fit': '0.5',
          Pinned: 'false',
          Tags: 'none',
          Outcomes: 'none',
        },
        CLEAN,
      ),
    );
    // Pinned rows do not decay, and an error tag doubles the half-life.
    expect(await s.run('inspect', 'mem_inspect_full')).toEqual(
      inspected(
        'mem_inspect_full',
        {
          'Retrieval count': '4',
          'Strength (live)': '1.00 (stored: 1.00)',
          'Half-life': '730d',
          Emotional: 'negative',
          'Schema fit': '0.5',
          Pinned: 'true',
          Tags: 'billing, error',
          Outcomes: '+2 / -1 (reward factor: 1.13)',
          'Conflicts with': 'mem_inspect_plain',
        },
        LONG,
      ),
    );
    expectUntouched(s, before);
  });

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', async () => {
    const s = clocked();
    s.seedAged('mem_inspect_other', CREATED, CLEAN, { tenantId: 'other' });
    s.settle();
    const before = held(s);
    expect(await s.run('inspect', MISSING)).toEqual(refused(`Memory not found: ${MISSING}`));
    expect(await s.run('inspect', 'mem_inspect_other')).toEqual(refused('Memory not found: mem_inspect_other'));
    expect(await s.run('inspect')).toEqual(refused('Please provide a memory ID.'));
    expect(await runOnUnreadableStore(s, 'inspect', 'mem_inspect_other')).toEqual(UNREADABLE);
    expectUntouched(s, before);
  });
});

describe('hippo share (built CLI, no server)', () => {
  it('a row whose transfer score is too low is not shared', async () => {
    const s = new Store({ global: true, spawned: true });
    const id = s.seed('the deploy cron reads its endpoint from config', { tags: ['deploy', 'cron', 'config'] });
    s.settle();
    const before = held(s);
    expect(await s.run('share', id)).toEqual(
      printed('Transfer score too low (0.05). This memory looks project-specific.\nUse --force to share anyway.\n'),
    );
    expect(s.audit('global')).toEqual([]);
    expectUntouched(s, before);
  });

  it('an unknown id, a row of another tenant, no id, and a store that cannot be read', async () => {
    const s = new Store({ global: true });
    const other = s.seed('the deploy cron reads its endpoint from config', {
      tags: ['deploy', 'cron', 'config'],
      tenantId: 'other',
    });
    s.settle();
    const before = held(s);
    expect(await s.run('share', MISSING)).toEqual(refused(`Error: Memory not found: ${MISSING}`));
    expect(await s.run('share', other)).toEqual(refused(`Error: Memory not found: ${other}`));
    expect(await s.run('share')).toEqual(
      refused('Usage: hippo share <memory_id> [--force] or hippo share --auto [--dry-run]'),
    );
    expect(await runOnUnreadableStore(s, 'share', other)).toEqual(UNREADABLE);
    expect(s.audit('global')).toEqual([]);
    expectUntouched(s, before);
  });
});

describe('hippo trace <id> (built CLI, no server)', () => {
  /** The head and strength block trace prints for an unpinned row seeded at CREATED with no retrievals. */
  const traced = (id: string, where: string, content: string, tags: string): string =>
    [
      `Memory: ${id}  [${where}]`,
      '='.repeat(50),
      `Content:   ${content}`,
      'Layer:     episodic   Confidence: verified       Pinned: no',
      `Tags:      ${tags}`,
      'Created:   <ts>  (12.0 days ago)',
      '',
      'Strength trajectory:',
      '  now:        0.977',
      '  in 30 days: 0.923',
      '  in 90 days: 0.824',
      '  half-life:  365.0d (stored) x 1.00 reward = 365.0d effective',
      '',
      'Retrieval:',
      '  count:      0',
      '  last:       <ts>  (12.0 days ago)',
      '',
      'Outcomes:   +0 / -0',
      '',
    ].join('\n');
  const lineage = (...parents: string[]): string =>
    ['', 'Parents (consolidation lineage):', ...parents.map((p) => `  - ${p}`), ''].join('\n');

  it('a local row with a local parent, a global parent and a missing one, as text and as json', async () => {
    const s = clocked({ global: true, spawned: true });
    s.seedAged('mem_trace_parent', CREATED, LONG);
    seedGlobal(s, 'mem_trace_gparent', 'a parent that only the global store holds');
    s.seedAged(
      'mem_trace_child',
      CREATED,
      CLEAN,
      { tags: ['billing'] },
      { parents: ['mem_trace_parent', 'mem_trace_gparent', MISSING] },
    );
    s.settle();
    const before = held(s);
    const parents = [
      { id: 'mem_trace_parent', content: LONG.slice(0, 70) },
      { id: 'mem_trace_gparent', content: 'a parent that only the global store holds' },
      { id: MISSING, content: '(not found)' },
    ];
    expect(await s.run('trace', 'mem_trace_child')).toEqual(
      printed(
        traced('mem_trace_child', 'local', CLEAN, 'billing') + lineage(...parents.map((p) => `${p.id}: ${p.content}`)),
      ),
    );
    const json = await s.run('trace', 'mem_trace_child', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({
      id: 'mem_trace_child',
      source: 'local',
      aged_out: false,
      pinned: false,
      tags: ['billing'],
      content: CLEAN,
      age_days: 12,
      retrieval_count: 0,
      half_life_days: 365,
      effective_half_life_days: 365,
      parents,
      open_conflicts: [],
    });
    expect(JSON.parse(json.stdout).strength_now).toBeCloseTo(0.977, 3);
    expect(await s.run('trace', 'mem_trace_parent')).toEqual(
      printed(traced('mem_trace_parent', 'local', `${LONG.slice(0, 160)}...`, '(none)')),
    );
    expectUntouched(s, before);
  });

  it('a row only the global store holds, and a parent of another tenant reads as not found', async () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_hidden', CREATED, LONG, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_global', CLEAN, {}, { parents: ['mem_trace_hidden'] });
    s.settle();
    const before = held(s);
    expect(await s.run('trace', 'mem_trace_global')).toEqual(
      printed(traced('mem_trace_global', 'global', CLEAN, '(none)') + lineage('mem_trace_hidden: (not found)')),
    );
    expectUntouched(s, before);
  });

  it('an unknown id with and without a global store, a row of another tenant, and a store that cannot be read', async () => {
    const s = clocked({ global: true });
    s.seedAged('mem_trace_other', CREATED, CLEAN, { tenantId: 'other' });
    seedGlobal(s, 'mem_trace_gother', CLEAN, { tenantId: 'other' });
    s.settle();
    const before = held(s);
    expect(await s.run('trace', MISSING)).toEqual(refused(`Memory not found: ${MISSING}`));
    expect(await s.run('trace', 'mem_trace_other')).toEqual(refused('Memory not found: mem_trace_other'));
    expect(await s.run('trace', 'mem_trace_gother')).toEqual(refused('Memory not found: mem_trace_gother'));
    expect(await runOnUnreadableStore(s, 'trace', 'mem_trace_other')).toEqual(UNREADABLE);
    expect(await clocked().run('trace', MISSING)).toEqual(refused(`Memory not found: ${MISSING}`));
    expectUntouched(s, before);
  });
});
