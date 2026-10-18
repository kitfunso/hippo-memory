// One sleep over three tenants ends with this exact store: memories, dormant rows, conflicts, run rows, sleep count,
// audit rows, particles, full-text rows and mirrors. Every host-wide step runs: the half-life move, decay, a trace,
// replay, physics, a retired text, merges with a tombstone refusal, the conflict replace and the run counters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createMemory, Layer, type CreateMemoryOptions, type MemoryEntry } from '../../src/core/memory.js';
import type { PhysicsParticle } from '../../src/core/physics.js';
import { loadConfig } from '../../src/core/config.js';
import { _resetAblationCacheForTests } from '../../src/core/ablation.js';
import { runConsolidation } from '../../src/consolidate/sleep.js';
import { closeHippoDb, getMeta, openHippoDb, setMeta, type DatabaseSyncLike } from '../../src/db/index.js';
import { savePhysicsState } from '../../src/db/physics-state.js';
import { upsertEntryRow } from '../../src/store/entry-row.js';
import { HALF_LIFE_BASE_META_KEY, TYPED_HALF_LIFE_META_KEY } from '../../src/store/open.js';
import { insertRejectedValue, normalizeValueForRejection, rejectionDigest } from '../../src/store/rejection.js';
import { appendSessionEvent } from '../../src/store/sessions.js';
import { sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { mergedText } from '../../src/util/same-text.js';
import { WRITE_BUDGET } from '../../src/util/write-budget.js';
import { makeRoot } from '../_helpers/make-root.js';

// Each case seeds and runs a full three-tenant sleep three times, once at one-row pages, which can pass the unit budget.
vi.setConfig({ testTimeout: 20_000 });

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DAY = 86_400_000;
const TENANTS = ['default', 'acme', 'globex'] as const;
const SEEDED_SIM = '2000-01-01T00:00:00.000Z';
const CLUSTER_HEADER = '[Consolidated pattern from 3 related memories, newest first]';
const fastBudget = { ...WRITE_BUDGET, pause: () => new Promise<void>((resolve) => setImmediate(resolve)) };

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
    ...createMemory(`${tenant} ${text}`, { baseHalfLifeDays: 7, tenantId: tenant, ...opts }),
    id: `mem_${tenant}_${String(n).padStart(2, '0')}`,
    created: new Date(NOW.getTime() - ageDays * DAY + n++ * 1000).toISOString(),
    last_retrieved: new Date(NOW.getTime() - idleDays * DAY).toISOString(),
    origin_project: 'hippo',
    ...extra,
  });
  const cluster = [0, 1, 2].map((k) =>
    row(`rotate the staging tls certificates before expiry and page the on-call channel v${k}`, 30, 1),
  );
  const kept = row('the billing export lands in the shared bucket nightly', 25, 2);
  const gone = row('the billing export lands in the legacy ftp drop nightly', 26, 2, {}, { superseded_by: kept.id });
  return [
    ...cluster,
    row(
      'rotate the staging tls certificates before expiry and page the on-call channel v9',
      30,
      1,
      {},
      { origin_project: 'other' },
    ),
    row('payments webhook retries are enabled for the eu cluster', 12, 1, { pinned: true }),
    row('payments webhook retries are disabled for the eu cluster', 11, 1),
    row('faded note about the retired staging cluster', 400, 400, {}, { half_life_days: 3 }),
    // Outcomes the memory-value weights rank in the tenant's top 30%, so that case rescues it.
    row(
      'faded note about the old vpn gateway',
      390,
      390,
      {},
      { half_life_days: 3, outcome_positive: 6, outcome_negative: 9 },
    ),
    row('faded deploy key for the build agents', 380, 380, { tags: ['secret'] }, { half_life_days: 3 }),
    row('decision: the api keeps semver for every public route', 60, 5, { source: 'decision' }, { half_life_days: 90 }),
    row('the dashboard caches tenant snapshots for five minutes', 50, 3, { layer: Layer.Semantic }),
    row('incident review notes for the march queue outage', 45, 40, {}, { retrieval_count: 3 }),
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
  const root = makeRoot('sleep-host-golden', { config: { physics: { enabled: true }, ...config } });
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
  sqliteSyncStore(root).localFiles.consolidation.replaceConflicts(
    [{ memory_a_id: 'mem_acme_04', memory_b_id: 'mem_acme_11', reason: 'stale', score: 0.6 }],
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

/** Everything a sleep writes, one JSON line per row, minus wall-clock stamps. */
function hostState(root: string) {
  return onStore(root, (db) => {
    const lines = (sql: string): string[] =>
      db
        .prepare(sql)
        .all()
        .map((r) => JSON.stringify(r));
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
  const local = sqliteSyncStore(root).localFiles;
  const result = await withCountedIds(() =>
    runConsolidation(local, { ...opts, now: NOW, config: loadConfig(root), budget: fastBudget }),
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
  _resetAblationCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetAblationCacheForTests();
});

describe('one sleep over three tenants', () => {
  // Each case also runs at one-row pages and at one page for the whole store, which must end the same.
  it('ends with the pinned store', async () => {
    expect(await sleepAtEveryPageSize({})).toMatchSnapshot();
  });

  it('ends with the pinned store when memory value rescues faded rows', async () => {
    expect(await sleepAtEveryPageSize({ memoryValue: { enabled: true } })).toMatchSnapshot();
  });

  it('previews the same run without writing', async () => {
    expect(await sleepAtEveryPageSize({}, { dryRun: true })).toMatchSnapshot();
  });
});
