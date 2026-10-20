// What `hippo remember`, `hippo supersede` and `hippo trace record` store, count, audit and print with no server.
// One case per verb spawns the built CLI; the rest run it in process.
import { describe, expect, it } from 'vitest';
import { reject, remember, adminActor } from '../../src/api/index.js';
import { PATH_TAGS, remembered, Store } from '../_helpers/cli-verb-store.js';
import { apiCtx } from '../_helpers/api-ctx.js';

const TEXT = 'the billing service retries a failed charge three times';
const NEWER = 'the billing service retries a failed charge five times';
const REJECTED = 'the billing service retries a failed charge nine times';
const REFUSED =
  'Error: Memory value refused: matches a rejected value (digest 2084ea4db93e..., reason: wrong). ' +
  'Run "hippo unreject" to allow it again.\n';

/** The columns of a stored row that the verbs here set. */
interface WrittenRow {
  content: string;
  layer: string;
  source: string;
  confidence: string;
  tags: readonly string[];
  strength: number;
  half_life_days: number;
  emotional_valence: string;
  pinned: number;
  kind: string;
  scope: string | null;
  owner: string | null;
  artifact_ref: string | null;
  origin_project: string;
  source_session_id: string | null;
}

/** A plain `hippo remember TEXT` row, which each flag case changes in the columns it names. */
const PLAIN_ROW: Omit<WrittenRow, 'source_session_id'> = {
  content: TEXT,
  layer: 'episodic',
  source: 'cli',
  confidence: 'verified',
  tags: PATH_TAGS,
  strength: 1,
  half_life_days: 365,
  emotional_valence: 'neutral',
  pinned: 0,
  kind: 'distilled',
  scope: null,
  owner: null,
  artifact_ref: null,
  origin_project: 'app',
};

const REMEMBER_FLAGS: ReadonlyArray<[string, string[], Partial<WrittenRow>]> = [
  ['plain', [], {}],
  ['--tag twice', ['--tag', 'billing', '--tag', 'retry'], { tags: ['billing', 'retry', ...PATH_TAGS] }],
  // An error doubles the half-life and marks the row negative.
  ['--error', ['--error'], { tags: ['error', ...PATH_TAGS], half_life_days: 730, emotional_valence: 'negative' }],
  ['--pin', ['--pin'], { pinned: 1 }],
  ['--observed', ['--observed'], { confidence: 'observed' }],
  ['--inferred', ['--inferred'], { confidence: 'inferred' }],
  ['--scope', ['--scope', 'team:eng'], { scope: 'team:eng', tags: [...PATH_TAGS, 'scope:team:eng'] }],
  ['--owner', ['--owner', 'user:alice'], { owner: 'user:alice' }],
  ['--artifact-ref', ['--artifact-ref', 'gh://acme/billing/pull/12'], { artifact_ref: 'gh://acme/billing/pull/12' }],
  ['--kind superseded', ['--kind', 'superseded'], { kind: 'superseded' }],
  [
    'every row flag at once',
    ['--tag', 'billing', '--error', '--pin', '--inferred', '--scope', 'team:eng', '--owner', 'user:alice'].concat([
      '--artifact-ref',
      'gh://acme/billing/pull/12',
      '--kind',
      'superseded',
    ]),
    {
      tags: ['billing', 'error', ...PATH_TAGS, 'scope:team:eng'],
      half_life_days: 730,
      emotional_valence: 'negative',
      pinned: 1,
      confidence: 'inferred',
      kind: 'superseded',
      scope: 'team:eng',
      owner: 'user:alice',
      artifact_ref: 'gh://acme/billing/pull/12',
    },
  ],
];

describe('hippo remember (built CLI, no server)', () => {
  it.each(REMEMBER_FLAGS)('%s', async (label, flags, changed) => {
    const s = new Store({ spawned: label === 'plain' });
    const ran = await s.run('remember', TEXT, ...flags);
    const [row] = s.rows();
    expect(s.rows()).toEqual([expect.objectContaining({ ...PLAIN_ROW, ...changed })]);
    expect(ran).toEqual(remembered(row!));
    expect(s.audit()).toEqual([`default cli remember ${String(row!['id'])}`]);
    expect(s.auditMeta()).toEqual([{ kind: changed.kind ?? 'distilled', scope: changed.scope ?? null }]);
    expect(s.counters()['total_remembered']).toBe('1');
  });

  it('--global stores in the global store and counts there', async () => {
    const s = new Store();
    const ran = await s.run('remember', TEXT, '--global');
    const rows = s.rows('global');
    expect(rows).toEqual([expect.objectContaining({ ...PLAIN_ROW, source: 'cli-global', origin_project: '' })]);
    expect(ran).toEqual(remembered(rows[0]!, '[global] '));
    expect([s.rows(), s.audit()]).toEqual([[], []]);
    expect(s.audit('global')).toEqual([`default cli remember ${String(rows[0]!['id'])}`]);
    expect([s.counters()['total_remembered'], s.counters('global')['total_remembered']]).toEqual(['0', '1']);
  });

  it('a second row whose tags the store already holds, and each row counts once', async () => {
    const s = new Store();
    const runs = [
      await s.run('remember', TEXT, '--tag', 'billing'),
      await s.run('remember', 'the invoice worker sends a receipt after each charge', '--tag', 'billing'),
    ];
    const rows = s.rows();
    expect(rows.map((r) => [r['content'], r['tags']])).toEqual([
      [TEXT, ['billing', ...PATH_TAGS]],
      ['the invoice worker sends a receipt after each charge', ['billing', ...PATH_TAGS]],
    ]);
    expect(runs).toEqual(rows.map((r) => remembered(r)));
    expect(s.audit()).toEqual(rows.map((r) => `default cli remember ${String(r['id'])}`));
    expect(s.counters()['total_remembered']).toBe('2');
  });

  it('a --kind outside the two allowed stores nothing and counts nothing', async () => {
    const s = new Store();
    for (const kind of ['raw', 'nonsense']) {
      expect(await s.run('remember', TEXT, '--kind', kind)).toEqual({
        status: 1,
        stdout: '',
        stderr:
          `Invalid --kind: "${kind}". Must be one of: distilled, superseded\n` +
          "(kind='raw' is reserved for ingestion connectors; kind='archived' is internal.)\n",
      });
    }
    expect([s.rows(), s.audit(), s.counters()['total_remembered']]).toEqual([[], [], '0']);
  });

  it('a rejected value is refused and not counted', async () => {
    const s = new Store();
    await reject(apiCtx(s.root, 'default', adminActor('cli')), { value: REJECTED, reason: 'wrong' });
    s.settle();
    expect(await s.run('remember', REJECTED)).toEqual({ status: 1, stdout: '', stderr: REFUSED });
    expect(s.rows()).toEqual([]);
    expect(s.audit()).toEqual([expect.stringMatching(/^default cli reject_refusal \S+$/)]);
    expect(s.auditMeta()[0]).toMatchObject({ reason: 'wrong' });
    expect(s.counters()['total_remembered']).toBe('0');
  });
});

// The new row keeps the old row's tags, pin and scope unless a flag names its own; confidence starts verified again.
const SUPERSEDE_FLAGS: ReadonlyArray<[string, string[], string[], Partial<WrittenRow>]> = [
  ['plain', [], [], { layer: 'episodic', tags: PATH_TAGS, pinned: 0 }],
  ['--layer', [], ['--layer', 'semantic'], { layer: 'semantic', tags: PATH_TAGS }],
  ['--tag', ['--tag', 'billing'], ['--tag', 'paging'], { tags: ['paging'] }],
  ['--pin', [], ['--pin'], { pinned: 1, tags: PATH_TAGS }],
  ['a pinned old row', ['--pin', '--tag', 'billing'], [], { pinned: 1, tags: ['billing', ...PATH_TAGS] }],
  [
    'every flag at once on a tagged, scoped old row',
    ['--tag', 'billing', '--scope', 'team:eng', '--observed'],
    ['--layer', 'semantic', '--tag', 'paging', '--tag', 'oncall', '--pin'],
    { layer: 'semantic', tags: ['paging', 'oncall'], pinned: 1, scope: 'team:eng' },
  ],
];

describe('hippo supersede (built CLI, no server)', () => {
  it.each(SUPERSEDE_FLAGS)('%s', async (label, oldFlags, flags, newRow) => {
    const s = new Store({ spawned: label === 'plain' });
    await s.run('remember', TEXT, ...oldFlags);
    const [held] = s.rows();
    const oldId = String(held!['id']);
    const ran = await s.run('supersede', oldId, NEWER, ...flags);
    const newId = s.lastId();
    expect(ran).toEqual({ status: 0, stdout: `Superseded ${oldId} → ${newId}\n`, stderr: '' });
    expect(s.rows()).toEqual([
      { ...held, superseded_by: newId },
      expect.objectContaining({ content: NEWER, confidence: 'verified', superseded_by: null, ...newRow }),
    ]);
    expect(s.audit()).toEqual([
      `default cli remember ${oldId}`,
      `default cli remember ${newId}`,
      `default cli supersede ${oldId}`,
    ]);
    expect(s.auditMeta()[2]).toEqual({ newId });
  });

  it('a missing id', async () => {
    const s = new Store();
    expect(await s.run('supersede', 'mem_does_not_exist', NEWER)).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Error: memory mem_does_not_exist not found.\n',
    });
    expect([s.rows(), s.audit()]).toEqual([[], []]);
  });

  it('an id that is already superseded', async () => {
    const s = new Store();
    await s.run('remember', TEXT);
    const oldId = s.lastId();
    await s.run('supersede', oldId, NEWER);
    const newId = s.lastId();
    expect(await s.run('supersede', oldId, 'the billing service retries a failed charge seven times')).toEqual({
      status: 1,
      stdout: '',
      stderr: `Error: memory ${oldId} is already superseded by ${newId}. Supersede that one instead.\n`,
    });
    expect(s.rows().map((r) => [r['content'], r['superseded_by']])).toEqual([
      [TEXT, newId],
      [NEWER, null],
    ]);
    expect(s.audit()).toHaveLength(3);
  });

  it('new content that is a rejected value', async () => {
    const s = new Store();
    await reject(apiCtx(s.root, 'default', adminActor('cli')), { value: REJECTED, reason: 'wrong' });
    s.settle();
    await s.run('remember', TEXT);
    const oldId = s.lastId();
    expect(await s.run('supersede', oldId, REJECTED)).toEqual({ status: 1, stdout: '', stderr: REFUSED });
    expect(s.rows()).toEqual([expect.objectContaining({ id: oldId, superseded_by: null })]);
    expect(s.audit()).toEqual([
      `default cli remember ${oldId}`,
      expect.stringMatching(/^default cli reject_refusal \S+$/),
    ]);
  });

  it("another person's personal row", async () => {
    const s = new Store();
    const owner = { subject: 'api_key:hk_a', role: 'member', owner: 'a' } as const;
    const { id } = await remember(apiCtx(s.root, 'default', owner), {
      content: 'my own note about the billing retry count',
      personal: true,
    });
    s.settle();
    const rows = s.rows();
    expect(await s.run('supersede', id, 'a newer note about the billing retry count')).toEqual({
      status: 1,
      stdout: '',
      stderr: `Error: memory ${id} not found.\n`,
    });
    expect(s.rows()).toEqual(rows);
    expect(rows[0]).toMatchObject({ scope: 'personal:private:a', superseded_by: null });
    expect(s.audit()).toEqual([]);
  });
});

describe('hippo trace record (built CLI, no server)', () => {
  const steps = JSON.stringify([
    { action: 'ran the migration', observation: 'two tables changed' },
    { action: 'ran the tests', observation: 'all passed' },
  ]);
  const content = (outcome: string): string =>
    `Task: migrate the billing tables\nOutcome: ${outcome}\nSteps:\n  1. ran the migration\n     → two tables changed\n` +
    '  2. ran the tests\n     → all passed';
  const RECORD = ['trace', 'record', '--task', 'migrate the billing tables', '--steps', steps];

  /** Runs one `trace record` and checks the row it printed, stored and audited. */
  async function recordsTrace(s: Store, outcome: string, flags: string[], row: Partial<WrittenRow>): Promise<void> {
    const ran = await s.run(...RECORD, '--outcome', outcome, ...flags);
    const id = s.lastId();
    expect(ran).toEqual({ status: 0, stdout: `Recorded trace ${id} (outcome=${outcome}, 2 steps)\n`, stderr: '' });
    expect(s.rows()).toEqual([
      expect.objectContaining({ layer: 'trace', content: content(outcome), trace_outcome: outcome, ...row }),
    ]);
    expect(s.audit()).toEqual([`default cli remember ${id}`]);
  }

  it('the required flags alone', async () => {
    await recordsTrace(new Store({ spawned: true }), 'success', [], {
      tags: [],
      source: 'cli',
      source_session_id: null,
    });
  });

  it('--session, --tag and --source', async () => {
    const flags = ['--session', 'sess-1', '--tag', 'deploy', '--source', 'agent'];
    await recordsTrace(new Store(), 'partial', flags, {
      tags: ['deploy'],
      source: 'agent',
      source_session_id: 'sess-1',
    });
  });

  it('an outcome outside the three', async () => {
    const s = new Store();
    expect(await s.run(...RECORD, '--outcome', 'unknown')).toEqual({
      status: 1,
      stdout: '',
      stderr: 'Invalid outcome: "unknown". Must be one of: success, failure, partial.\n',
    });
    expect(s.rows()).toEqual([]);
  });
});
