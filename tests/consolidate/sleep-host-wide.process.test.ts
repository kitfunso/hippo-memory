// One sleep over three tenants: the rows it keeps, moves, merges, retires, makes dormant and removes, and the audit,
// conflict, particle, run, full-text and mirror rows it leaves. Every host-wide step runs: the half-life move, decay, a
// trace, replay, physics, a retired text, merges with a tombstone refusal, the conflict replace and the run counters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createMemory, Layer, type CreateMemoryOptions, type MemoryEntry } from '../../src/base/memory/memory.js';
import type { PhysicsParticle } from '../../src/base/rank/physics.js';
import { loadConfig } from '../../src/base/config/config.js';
import { runConsolidation } from '../../src/domain/consolidate/sleep.js';
import { closeHippoDb, getMeta, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { savePhysicsState } from '../../src/db/physics-state.js';
import { upsertEntryRow } from '../../src/store/sqlite/entry-row.js';
import { HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY } from '../../src/store/sqlite/open.js';
import { insertRejectedValue } from '../../src/store/sqlite/rejection.js';
import { normalizeValueForRejection, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { WRITE_BUDGET } from '../../src/base/util/write-budget.js';
import { makeRoot } from '../_helpers/make-root.js';
import { appendSessionEvent } from '../_helpers/root-forms.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const TENANTS = ['default', 'acme', 'globex'] as const;
const SEEDED_SIM = '2000-01-01T00:00:00.000Z';
const CLUSTER_HEADER = '[Consolidated pattern from 3 related memories, newest first]';

type Tenant = (typeof TENANTS)[number];

/** Seeded rows get fixed ids and times; every row starts on the 7-day base the half-life move leaves. */
function rowsOf(tenant: Tenant): MemoryEntry[] {
  let n = 0;
  const row = (
    text: string,
    ageDays: number,
    idleDays: number,
    opts: Partial<CreateMemoryOptions> = {},
    extra: Partial<MemoryEntry> = {},
  ): MemoryEntry => ({
    ...createMemory(`${tenant} ${text}`, {
      baseHalfLifeDays: 7,
      tenantId: tenant,
      ...opts,
    }),
    id: `mem_${tenant}_${String(n).padStart(2, '0')}`,
    created: new Date(NOW.getTime() - ageDays * DAY + n++ * 1000).toISOString(),
    lastRetrieved: new Date(NOW.getTime() - idleDays * DAY).toISOString(),
    originProject: 'hippo',
    ...extra,
  });
  const cluster = [0, 1, 2].map((k) =>
    row(`rotate the staging tls certificates before expiry and page the on-call channel v${k}`, 30, 1),
  );
  const kept = row('the billing export lands in the shared bucket nightly', 25, 2);
  const gone = row('the billing export lands in the legacy ftp drop nightly', 26, 2, {}, { supersededBy: kept.id });
  return [
    ...cluster,
    row(
      'rotate the staging tls certificates before expiry and page the on-call channel v9',
      30,
      1,
      {},
      { originProject: 'other' },
    ),
    row('payments webhook retries are enabled for the eu cluster', 12, 1, {
      pinned: true,
    }),
    row('payments webhook retries are disabled for the eu cluster', 11, 1),
    row('faded note about the retired staging cluster', 400, 400, {}, { halfLifeDays: 3 }),
    // Outcomes the memory-value weights rank in the tenant's top 30%, so that case rescues it.
    row(
      'faded note about the old vpn gateway',
      390,
      390,
      {},
      { halfLifeDays: 3, outcomePositive: 6, outcomeNegative: 9 },
    ),
    row('faded deploy key for the build agents', 380, 380, { tags: ['secret'] }, { halfLifeDays: 3 }),
    row('decision: the api keeps semver for every public route', 60, 5, { source: 'decision' }, { halfLifeDays: 90 }),
    row('the dashboard caches tenant snapshots for five minutes', 50, 3, {
      layer: Layer.Semantic,
    }),
    row('incident review notes for the march queue outage', 45, 40, {}, { retrievalCount: 3 }),
    row('the search index rebuild runs after every schema change', 15, 2),
    kept,
    gone,
    row(
      'merged',
      24,
      2,
      { layer: Layer.Semantic, source: 'consolidation' },
      {
        parents: [gone.id, kept.id],
        content: mergedText('[Consolidated from 2 related memories, newest first]', [kept.content, gone.content]),
      },
    ),
  ];
}

function particle(memoryId: string, i: number): PhysicsParticle {
  const raw = [Math.cos(i), Math.sin(i), Math.cos(i * 0.7), Math.sin(i * 1.3)];
  const norm = Math.hypot(...raw);
  return {
    memoryId,
    position: raw.map((v) => v / norm),
    velocity: [0, 0, 0, 0],
    mass: 1,
    charge: 0,
    temperature: 1,
    lastSimulation: SEEDED_SIM,
  };
}

function onStore<T>(root: string, work: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(root);
  try {
    return work(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Three tenants on the legacy half-life base, with particles, a completed session, an open conflict and a tombstoned merge. */
function seed(config: { memoryValue?: { enabled: boolean } }): string {
  const root = makeRoot('sleep-host-golden', {
    config: { physics: { enabled: true }, ...config },
  });
  const rows = TENANTS.flatMap(rowsOf);
  onStore(root, (db) => {
    db.exec('BEGIN');
    for (const row of rows) upsertEntryRow(db, row);
    db.exec('COMMIT');
    savePhysicsState(
      db,
      rows.filter((_, i) => i % 3 === 0).map((r, i) => particle(r.id, i)),
    );
    setMeta(db, HALF_LIFE_BASE_META_KEY, '7');
    setMeta(db, TYPED_HALF_LIFE_META_KEY, '');
    const globex = rowsOf('globex')
      .slice(0, 3)
      .map((r) => r.content)
      .reverse();
    const refused = mergedText(CLUSTER_HEADER, globex);
    insertRejectedValue(db, {
      tenantId: 'globex',
      digest: rejectionDigest(refused),
      reason: 'pinned refusal',
      rejectedBy: 'test',
      rejectedAt: NOW.toISOString(),
      normalizedChars: normalizeValueForRejection(refused).length,
    });
  });
  sqliteSyncStore(handlesOf(root)).consolidation.replaceConflicts(
    [
      {
        memory_a_id: 'mem_acme_04',
        memory_b_id: 'mem_acme_11',
        reason: 'stale',
        score: 0.6,
      },
    ],
    NOW.toISOString(),
  );
  const session = 'sess-golden';
  appendSessionEvent(root, 'default', {
    session_id: session,
    event_type: 'action',
    content: 'read the deploy runbook',
    source: 'agent',
  });
  appendSessionEvent(root, 'default', {
    session_id: session,
    event_type: 'session_complete',
    content: 'success',
    source: 'agent',
    metadata: { summary: 'deployed the fix' },
  });
  return root;
}

/** Ids from a counter, so every run mints the same ones; generateId keeps randomUUID's first 12 hex digits. */
async function withCountedIds<T>(run: () => Promise<T>): Promise<T> {
  let n = 0;
  const spy = vi
    .spyOn(crypto, 'randomUUID')
    .mockImplementation(() => `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`);
  syncBuiltinESMExports();
  try {
    return await run();
  } finally {
    spy.mockRestore();
    syncBuiltinESMExports();
  }
}

function columnsBut(db: DatabaseSyncLike, table: string, skip: readonly string[]): string {
  // SAFETY: pragma_table_info yields one row per column with its name.
  const names = (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  return names.filter((name) => !skip.includes(name)).join(', ');
}

// node:sqlite cells; the particle blobs are read as hex text.
type Row = Record<string, string | number | null>;
type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
type JsonObject = { readonly [key: string]: Json };

/** Everything a sleep writes, minus wall-clock stamps. */
function hostState(root: string) {
  return onStore(root, (db) => {
    // SAFETY: node:sqlite answers each row as a plain column-keyed object.
    const lines = (sql: string): Row[] => db.prepare(sql).all() as Row[];
    return {
      memories: lines(`SELECT ${columnsBut(db, 'memories', ['updated_at'])} FROM memories ORDER BY id`),
      dormant: lines(`SELECT ${columnsBut(db, 'dormant_memories', ['updated_at'])} FROM dormant_memories ORDER BY id`),
      conflicts: lines('SELECT * FROM memory_conflicts ORDER BY id'),
      runs: lines('SELECT timestamp, decayed, merged, removed FROM consolidation_runs ORDER BY id'),
      sleepCount: getMeta(db, 'sleep_count', '0'),
      halfLifeBase: [getMeta(db, HALF_LIFE_BASE_META_KEY), getMeta(db, TYPED_HALF_LIFE_META_KEY)],
      audit: lines('SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY id'),
      particles: lines(
        `SELECT memory_id, hex(position_blob) AS position, hex(velocity_blob) AS velocity, mass, charge, temperature, ` +
          `last_simulation != '${SEEDED_SIM}' AS simulated FROM memory_physics ORDER BY memory_id`,
      ),
      fts: lines('SELECT id, content, tags FROM memories_fts ORDER BY id, content'),
      mirrors: fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && !e.name.startsWith('hippo.db'))
        .map((e) => path.relative(root, path.join(e.parentPath, e.name)).replace(/\\/g, '/'))
        .sort(),
    };
  });
}

async function sleepOnce(root: string, opts: { dryRun?: boolean; pageRows?: number } = {}) {
  const local = sqliteStore(root);
  const result = await withCountedIds(() =>
    runConsolidation(local, {
      ...opts,
      now: NOW,
      config: loadConfig(root),
      tenantId: 'default',
    }),
  );
  return { result, state: hostState(root) };
}

/** The default page's sleep, after checking one-row pages and one page for the whole store end the same. */
async function sleepAtEveryPageSize(config: { memoryValue?: { enabled: boolean } }, opts: { dryRun?: boolean } = {}) {
  const pinned = await sleepOnce(seed(config), opts);
  for (const pageRows of [1, Infinity]) expect(await sleepOnce(seed(config), { ...opts, pageRows })).toEqual(pinned);
  return pinned;
}

beforeEach(() => {
  vi.stubEnv('HIPPO_FAKE_NOW', NOW.toISOString());
  vi.stubEnv('HIPPO_TENANT', 'default');
  // The store reads its pause at each flush, so a yield here stands in for the real gap between chunks.
  vi.spyOn(WRITE_BUDGET, 'pause').mockImplementation(() => new Promise<void>((resolve) => setImmediate(resolve)));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type HostState = ReturnType<typeof hostState>;
type SleepResult = Awaited<ReturnType<typeof sleepOnce>>['result'];

const BY_NAME = ['acme', 'default', 'globex'] as const;
// The order the sleep reaches each tenant's retired text, and the tenants whose cluster merges (globex's is refused).
const RETIRED = ['globex', 'default', 'acme'] as const;
const CLUSTERED = ['acme', 'default'] as const;
const BILLING = 'the billing export lands in the shared bucket nightly';
const idOf = (tenant: Tenant, n: number): string => `mem_${tenant}_${String(n).padStart(2, '0')}`;
// generateId keeps the first 12 hex digits of the counted UUID.
const minted = (prefix: string, n: number): string => `${prefix}_${n.toString(16).padStart(8, '0')}0000`;
const TRACE = minted('mem', 1);
const IDLE_STEPS = {
  dagCandidateClusters: 0,
  dagSummariesCreated: 0,
  dormantExpired: 0,
  entityProfilesCreated: 0,
  extracted: 0,
  summariesRebuildCapped: false,
  summariesRebuildFailed: 0,
  summariesRebuildRefused: 0,
  summariesRebuilt: 0,
  summariesZeroChildSkipped: 0,
  tracesSkippedMixedScope: 0,
};

/** A live row as `tenant layer half-life retrievals`, then its successor when superseded. */
const described = (tenant: string, layer: string, halfLife: number, retrievals: number, by: string | null = null) =>
  `${tenant} ${layer} ${halfLife}d x${retrievals}${by === null ? '' : ` > ${by}`}`;

const live = (state: HostState) =>
  Object.fromEntries(
    state.memories.map((m) => [
      String(m['id']),
      described(
        String(m['tenant_id']),
        String(m['layer']),
        Number(m['half_life_days']),
        Number(m['retrieval_count']),
        m['superseded_by'] === null ? null : String(m['superseded_by']),
      ),
    ]),
  );

/** The live rows both writing sleeps leave before replay: moved half-lives, merged clusters and retired texts. */
function sleptRows() {
  const seeded = BY_NAME.flatMap((t): Array<[string, string]> => [
    // A merged cluster's rows drop to a short half-life; the superseded row keeps its old one.
    ...[0, 1, 2].map((n): [string, string] => [idOf(t, n), described(t, 'episodic', t === 'globex' ? 365 : 109, 0)]),
    ...[3, 5, 6, 7, 11, 14].map((n): [string, string] => [idOf(t, n), described(t, 'episodic', 365, 0)]),
    [idOf(t, 4), described(t, 'episodic', 7, 0, idOf(t, 3))],
    [idOf(t, 12), described(t, 'semantic', 365, 0)],
    [idOf(t, 13), described(t, 'episodic', 365, 3)],
  ]);
  const made = [...RETIRED.map((t, i) => [t, i + 2] as const), ...CLUSTERED.map((t, i) => [t, i + 5] as const)];
  return Object.fromEntries([
    ...seeded,
    ...made.map(([t, n]): [string, string] => [minted('sem', n), described(t, 'semantic', 365, 0)]),
  ]);
}

const tls = (t: Tenant, k: number): string =>
  `- ${t} rotate the staging tls certificates before expiry and page the on-call channel v${k}`;
const MADE = [
  {
    id: TRACE,
    source: 'auto-promote',
    parents: [],
    tags: ['auto-promoted'],
    content: 'Task: deployed the fix\nOutcome: success\nSteps:\n  1. read the deploy runbook',
  },
  ...RETIRED.map((t, i) => ({
    id: minted('sem', i + 2),
    source: 'consolidation',
    parents: [idOf(t, 3)],
    tags: [],
    content: `[Consolidated from 1 related memory, newest first]\n\n- ${t} ${BILLING}`,
  })),
  ...CLUSTERED.map((t, i) => ({
    id: minted('sem', i + 5),
    source: 'consolidation',
    parents: [0, 1, 2].map((n) => idOf(t, n)),
    tags: [],
    content: `${CLUSTER_HEADER}\n\n${[2, 1, 0].map((k) => tls(t, k)).join('\n')}`,
  })),
];

const made = (state: HostState) =>
  state.memories
    .filter((m) => MADE.some((e) => e.id === m['id']))
    .map((m) => ({
      id: m['id'],
      source: m['source'],
      parents: JSON.parse(String(m['parents_json'])),
      tags: JSON.parse(String(m['tags_json'])),
      content: m['content'],
    }));

/** The detail lines less their leading emoji. */
const detailText = (result: SleepResult): string[] => result.details.map((d) => d.replace(/^\s*\S+\s+/, ''));
const faded = (verb: string, n: number): string[] =>
  BY_NAME.map((t) => `${verb} ${idOf(t, n)} (strength 0.0000 < 0.05)`);
const MERGED_LINE = `merged 3 episodic entries into semantic: "${CLUSTER_HEADER}..."`;
const RESCUED = BY_NAME.map(
  (t) => `${idOf(t, 9)} (strength 0.0000 < 0.05) - rescued (rank 1/15 in tenant ${t}, top 5)`,
);

function sleepDetails(rescued: boolean, replayed: readonly string[]): unknown[] {
  return [
    'moved 33 memories from the 7-day to the 365-day half-life',
    'moved 3 memories of decisions, incidents and other objects from the 90-day to the 365-day half-life',
    ...faded('dormant', 8),
    ...(rescued ? RESCUED : faded('dormant', 9)),
    ...faded('removed', 10),
    `promoted trace ${TRACE} from session sess-golden (success)`,
    'promoted 1 trace from completed session',
    `replayed 5 memories: ${replayed.join(', ')}`,
    expect.stringMatching(/^physics: 16 particles, avg vel \d\.\d{4}$/),
    ...RETIRED.map((t, i) => `${idOf(t, 15)} held a retired text, ${minted('sem', i + 2)} holds the rest`),
    ...CLUSTERED.map(() => MERGED_LINE),
    'detected 3 memory conflicts',
  ];
}

function sleepCounts(o: { decayed: number; dormant: number; extractionCandidates: number }) {
  return {
    ...IDLE_STEPS,
    ...o,
    dryRun: false,
    removed: 6,
    removedIds: [...BY_NAME.map((t) => idOf(t, 10)), ...RETIRED.map((t) => idOf(t, 15))],
    merged: 6,
    semanticCreated: 2,
    promotedTraces: 1,
    replayed: 5,
    physicsSimulated: 16,
  };
}

const auditLines = (state: HostState): string[] =>
  state.audit.map((a) => [a['tenant_id'], a['actor'], a['op'], a['target_id']].filter((p) => p != null).join(' '));
// SAFETY: every audit writer stores a JSON object in metadata_json.
const auditMeta = (state: HostState, op: string): JsonObject[] =>
  state.audit.filter((a) => a['op'] === op).map((a) => JSON.parse(String(a['metadata_json'])) as JsonObject);
// Live rows on the old 7-day base move; the faded rows on their own 3 days and the superseded row do not.
const MOVED = [0, 1, 2, 3, 5, 6, 7, 12, 13, 14, 15];

function expectAudit(state: HostState, rescued: boolean): void {
  expect(auditLines(state)).toEqual([
    ...BY_NAME.map((t) => `${t} system half_life_migrate`),
    ...BY_NAME.map((t) => `${t} system half_life_migrate`),
    'globex sleep reject_refusal',
    ...(rescued ? BY_NAME.map((t) => `${t} sleep mv_rescue ${idOf(t, 9)}`) : []),
  ]);
  // SAFETY: a half-life move lists the ids it moved as strings.
  const moves = auditMeta(state, 'half_life_migrate').map((m) => [
    m['from'],
    m['to'],
    [...(m['ids'] as string[])].sort(),
  ]);
  expect(moves).toEqual([
    ...BY_NAME.map((t) => [7, 365, MOVED.map((n) => idOf(t, n))]),
    ...BY_NAME.map((t) => [90, 365, [idOf(t, 11)]]),
  ]);
  expect(auditMeta(state, 'reject_refusal')).toMatchObject([
    {
      reason: 'pinned refusal',
      sourceIds: [0, 1, 2].map((n) => idOf('globex', n)),
    },
  ]);
  const rescues = auditMeta(state, 'mv_rescue');
  expect(rescues.map(({ score: _, ...rank }) => rank)).toEqual(
    rescues.map(() => ({ rank: 1, totalNonPinned: 15, keepN: 5 })),
  );
  expect(rescues.every((m) => Number(m['score']) > 0)).toBe(true);
}

/** Particles of rows that left are dropped, every other one moved; mirrors name only live rows and open conflicts. */
function expectFollowers(state: HostState, liveRows: Readonly<Record<string, string>>): void {
  const seeded = TENANTS.flatMap(rowsOf).filter((_, i) => i % 3 === 0);
  expect(state.particles.map((p) => p['memory_id'])).toEqual(
    seeded
      .map((r) => r.id)
      .filter((id) => id in liveRows)
      .sort(),
  );
  expect(state.particles.every((p) => p['simulated'] === 1)).toBe(true);
  expect(state.fts.map((f) => [f['id'], f['content']])).toEqual(state.memories.map((m) => [m['id'], m['content']]));
  const liveFiles = new Set(state.memories.map((m) => `${String(m['layer'])}/${String(m['id'])}.md`));
  const rowMirrors = state.mirrors.filter((f) => /^(episodic|semantic|trace)\//.test(f));
  expect(rowMirrors.filter((f) => !liveFiles.has(f))).toEqual([]);
  expect(rowMirrors).toEqual(
    expect.arrayContaining(MADE.map((e) => (e.id === TRACE ? 'trace' : 'semantic') + `/${e.id}.md`)),
  );
  const open = state.conflicts
    .filter((c) => c['status'] === 'open')
    .map((c) => `conflicts/conflict_${String(c['id'])}.md`);
  expect(state.mirrors.filter((f) => f.startsWith('conflicts/'))).toEqual(open);
}

function expectSleptStore(
  state: HostState,
  o: { decayed: number; rescued: boolean; replayed: Readonly<Record<string, string>> },
): void {
  const liveRows = live(state);
  expect(liveRows).toEqual({ ...sleptRows(), ...o.replayed });
  expect(made(state)).toEqual(MADE);
  const dormant = o.rescued ? [8] : [8, 9];
  expect(state.dormant.map((d) => `${String(d['tenant_id'])} ${String(d['id'])} ${String(d['reason'])}`)).toEqual(
    BY_NAME.flatMap((t) => dormant.map((n) => `${t} ${idOf(t, n)} decay`)),
  );
  // SAFETY: a dormant row keeps the whole memory row as a JSON object.
  const entries = state.dormant.map((d) => JSON.parse(String(d['entry_json'])) as JsonObject);
  expect(entries.map((e) => e['id'])).toEqual(state.dormant.map((d) => d['id']));
  expect(
    state.conflicts.map((c) => `${String(c['memory_a_id'])} ${String(c['memory_b_id'])} ${String(c['status'])}`),
  ).toEqual(['mem_acme_04 mem_acme_11 resolved', ...BY_NAME.map((t) => `${idOf(t, 6)} ${idOf(t, 7)} open`)]);
  expect(state.runs).toEqual([{ timestamp: NOW.toISOString(), decayed: o.decayed, merged: 6, removed: 6 }]);
  expect([state.sleepCount, state.halfLifeBase]).toEqual(['1', ['365', '1']]);
  expectAudit(state, o.rescued);
  expectFollowers(state, liveRows);
}

describe('one sleep over three tenants', () => {
  // Each case also runs at one-row pages and at one page for the whole store, which must end the same.
  it('moves, decays, promotes, replays, retires, merges and records each tenant on its own rows', async () => {
    const { result, state } = await sleepAtEveryPageSize({});
    const { details: _, ...counts } = result;
    expect(counts).toEqual(sleepCounts({ decayed: 39, dormant: 6, extractionCandidates: 30 }));
    const replayed = [idOf('globex', 1), idOf('acme', 15), idOf('acme', 12), idOf('default', 15), TRACE];
    expect(detailText(result)).toEqual(sleepDetails(false, replayed));
    // A replayed row whose text is retired hands its retrieval to the row that holds the rest.
    const bumped = {
      [idOf('globex', 1)]: described('globex', 'episodic', 367, 1),
      [idOf('acme', 12)]: described('acme', 'semantic', 367, 1),
      [minted('sem', 3)]: described('default', 'semantic', 367, 1),
      [minted('sem', 4)]: described('acme', 'semantic', 367, 1),
      [TRACE]: described('default', 'trace', 367, 1),
    };
    expectSleptStore(state, { decayed: 39, rescued: false, replayed: bumped });
  });

  it('keeps each tenant top-ranked faded row live and audited when memory value rescues it', async () => {
    const { result, state } = await sleepAtEveryPageSize({
      memoryValue: { enabled: true },
    });
    const { details: _, ...counts } = result;
    expect(counts).toEqual(sleepCounts({ decayed: 42, dormant: 3, extractionCandidates: 33 }));
    const replayed = [idOf('default', 1), idOf('globex', 3), idOf('default', 11), idOf('default', 15), TRACE];
    expect(detailText(result)).toEqual(sleepDetails(true, replayed));
    const bumped = {
      [idOf('default', 1)]: described('default', 'episodic', 110, 1),
      [idOf('globex', 3)]: described('globex', 'episodic', 367, 1),
      [idOf('default', 11)]: described('default', 'episodic', 367, 1),
      [minted('sem', 3)]: described('default', 'semantic', 367, 1),
      [TRACE]: described('default', 'trace', 367, 1),
      ...Object.fromEntries(BY_NAME.map((t) => [idOf(t, 9), described(t, 'episodic', 3, 0)])),
    };
    expectSleptStore(state, { decayed: 42, rescued: true, replayed: bumped });
  });

  it('previews the same run without writing', async () => {
    const unslept = hostState(seed({}));
    const { result, state } = await sleepAtEveryPageSize({}, { dryRun: true });
    expect(state).toEqual(unslept);
    const { details: _, ...counts } = result;
    expect(counts).toEqual({
      ...sleepCounts({ decayed: 39, dormant: 6, extractionCandidates: 30 }),
      dryRun: true,
      removed: 3,
      removedIds: BY_NAME.map((t) => idOf(t, 10)),
      // A preview does not check the refusal, so globex's cluster counts too.
      merged: 9,
      semanticCreated: 0,
      promotedTraces: 0,
      physicsSimulated: 0,
    });
    expect(detailText(result)).toEqual([
      'would move 33 memories from the 7-day to the 365-day half-life',
      'would move 3 memories of decisions, incidents and other objects from the 90-day to the 365-day half-life',
      ...faded('dormant', 8),
      ...faded('dormant', 9),
      ...faded('removed', 10),
      `replayed 5 memories: ${[idOf('globex', 1), idOf('globex', 3), idOf('acme', 12), idOf('default', 15), idOf('globex', 7)].join(', ')}`,
      ...RETIRED.map((t, i) => `${idOf(t, 15)} held a retired text, ${minted('sem', i + 1)} holds the rest`),
      ...TENANTS.map(() => MERGED_LINE),
    ]);
  });
});
