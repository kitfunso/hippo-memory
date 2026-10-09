// The rows getContext reads, added to the two-tenant conformance fixture: pins, a recent window one project crowds, every
// scope and supersede edge, secret tags, a drifted date, and task state with keys, ties, private rows and stale rows.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { JsonValue } from '../../src/util/json.js';
import { Layer, type MemoryEntry } from '../../src/core/memory.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { initStore } from '../../src/store/open.js';
import { rowsOf, seeded } from './recall-golden-seed.js';
import { TENANT_A, TENANT_B } from './store-conformance.js';

/** Every row's time is set against this, so a test pins the clock here. */
export const CONTEXT_NOW = '2026-03-10T12:00:00.000Z';
export const SESSION = 'ctx-session-a';
export const KEYED_SESSION = 'ctx-session-k';
export const PROJECT = 'proj';
export const OWNER = 'alice';
export const OWN_SCOPE = `personal:private:${OWNER}`;

export const ago = (hours: number): string => new Date(Date.parse(CONTEXT_NOW) - hours * 3_600_000).toISOString();

type SeedOpts = Parameters<typeof seeded>[4];

function inTenant(tenantId: string, origin: string | null) {
  return (content: string, id: string, hours: number, extra: Partial<MemoryEntry> = {}, opts: SeedOpts = {}): MemoryEntry =>
    seeded(content, id, ago(hours), { tenantId, origin_project: origin, ...extra }, opts);
}

function memoryRows(): MemoryEntry[] {
  const a = inTenant(TENANT_A, PROJECT);
  const b = inTenant(TENANT_B, PROJECT);
  return [
    a('pinned rule: no deploys to the billing service on fridays', 'mem_a_pin', 500, {}, { pinned: true }),
    a('pinned rule from the other project about its release train', 'mem_a_pin_other', 400, { origin_project: 'other' }, { pinned: true }),
    a('pinned private note about the billing escalation channel', 'mem_a_pin_private', 300, {}, { pinned: true, scope: 'slack:private:C1' }),
    ...Array.from({ length: 40 }, (_, i) =>
      a(`other project status update ${i} for the warehouse sync`, `mem_a_other_${String(i).padStart(2, '0')}`, 0.5 + i / 10, { origin_project: 'other' })),
    ...Array.from({ length: 6 }, (_, i) => a(`own project rollout step ${i} moved the queue workers`, `mem_a_own_${i}`, 10 + i)),
    ...Array.from({ length: 3 }, (_, i) => a(`user global preference ${i}: keep commits small for review`, `mem_a_global_${i}`, 20 + i, { origin_project: '' })),
    a('team rota covers the rollout pager this week', 'mem_a_team', 30, {}, { scope: 'team:eng' }),
    a('alice reminder to renew the rollout certificate', 'mem_a_alice', 31, {}, { scope: OWN_SCOPE }),
    a('bob reminder to rotate the rollout dashboards', 'mem_a_bob', 32, {}, { scope: 'personal:private:bob' }),
    a('legacy import about the rollout freeze', 'mem_a_legacy', 33, {}, { scope: 'unknown:legacy' }),
    a('rollout target was the old staging cluster', 'mem_a_old', 60, { superseded_by: 'mem_a_new' }),
    a('rollout target is the new staging cluster', 'mem_a_new', 41),
    a('rollout note whose supersede link was blanked', 'mem_a_blank', 42, { superseded_by: '' }),
    a('archived rollout plan from last quarter', 'mem_a_archived', 43, { kind: 'archived' }),
    a('own project vault path lives in the ops runbook', 'mem_a_secret_own', 44, {}, { tags: ['secret'] }),
    a('other project vault path lives in its runbook', 'mem_a_secret_other', 45, { origin_project: 'other' }, { tags: ['Token'] }),
    a('user global vault path lives in the home runbook', 'mem_a_secret_global', 46, { origin_project: '' }, { tags: ['password'] }),
    a('build failed when the zebra cache was cold', 'mem_a_error', 47, { conflicts_with: ['mem_a_own_1'] }, {
      tags: ['error:build'], layer: Layer.Semantic, emotional_valence: 'negative', schema_fit: 0.9, extracted_from: 'mem_a_own_0', dag_level: 2,
    }),
    a('legacy row with no recorded origin about the rollout', 'mem_a_no_origin', 48, { origin_project: null }),
    a('rollout lesson that decays within a day', 'mem_a_decayed', 200, { half_life_days: 1 }),
    a('rollout lesson that kept paying off', 'mem_a_liked', 100, { outcome_positive: 3, last_retrieved: ago(2) }),
    a('rollout lesson with no half life', 'mem_a_flat', 49, { half_life_days: 0 }),
    b('globex pinned rule about the deploy window', 'mem_b_pin', 50, {}, { pinned: true }),
    ...Array.from({ length: 5 }, (_, i) => b(`globex note ${i} about the rollout plan`, `mem_b_${i}`, 5 + i)),
    seeded('globex drifted row written by an old importer', 'mem_b_drift', '2026-03-05 10:00:00', { tenantId: TENANT_B, origin_project: PROJECT }),
  ];
}

type Row = readonly (string | number | null)[];

// tenant, task, status, session, scope, hours since the update, owner, origin
const SNAPSHOTS: readonly Row[] = [
  [TENANT_A, 'superseded unkeyed task', 'superseded', SESSION, null, 1, null, null],
  [TENANT_A, 'unkeyed task for session a', 'active', SESSION, null, 3, null, null],
  [TENANT_A, 'alice task, older id', 'active', KEYED_SESSION, null, 4, OWNER, PROJECT],
  [TENANT_A, 'alice task, newer id', 'active', KEYED_SESSION, null, 4, OWNER, PROJECT],
  [TENANT_A, 'bob task', 'active', 'ctx-session-bob', null, 6, 'bob', PROJECT],
  [TENANT_A, 'alice task in another project', 'active', 'ctx-session-x', null, 8, OWNER, 'other'],
  [TENANT_B, 'globex task gone stale', 'active', SESSION, null, 100, null, null],
];

// tenant, session, summary, outcome, scope, hours since it was written, owner, origin
const HANDOFFS: readonly Row[] = [
  [TENANT_A, SESSION, 'first handoff for session a', null, null, 2.5, null, null],
  [TENANT_A, SESSION, 'second handoff for session a', 'success', null, 1, null, null],
  [TENANT_A, 'ctx-session-b', 'partial handoff for session b', 'partial', null, 3, null, null],
  [TENANT_A, 'ctx-session-c', 'private handoff for session c', null, 'slack:private:C9', 0.5, null, null],
  [TENANT_A, 'ctx-session-d', 'stale handoff for session d', null, null, 100, null, null],
  [TENANT_A, KEYED_SESSION, 'alice handoff', null, null, 4, OWNER, PROJECT],
  [TENANT_A, 'ctx-session-e', 'failed handoff e, older id', 'failure', null, 6, null, null],
  [TENANT_A, 'ctx-session-e', 'failed handoff e, newer id', 'failure', null, 6, null, null],
  [TENANT_B, SESSION, 'globex handoff', null, null, 1, null, null],
];

// tenant, session, content, scope, hours since it happened, metadata
const EVENTS: readonly Row[] = [
  [TENANT_A, SESSION, 'opened the rollout ticket', null, 7, '{}'],
  [TENANT_A, SESSION, 'ran the canary', null, 6, '{"step":2}'],
  [TENANT_A, SESSION, 'private channel ping', 'slack:private:C2', 5, '{}'],
  [TENANT_A, SESSION, 'promoted the canary', null, 4, 'not json'],
  [TENANT_A, SESSION, 'paged the on-call', null, 3, '[1,2]'],
  [TENANT_A, SESSION, 'same time, lower id', null, 1, '{}'],
  [TENANT_A, SESSION, 'same time, higher id', null, 1, '{}'],
  [TENANT_A, KEYED_SESSION, 'alice event', null, 4, '{}'],
  [TENANT_B, SESSION, 'globex event one', null, 2, '{}'],
  [TENANT_B, SESSION, 'globex event two', null, 1, '{}'],
];

const hours = (v: string | number | null): number => Number(v);

// Inserted by hand, since the save functions stamp the real clock and supersede the tenant's other active rows.
function insertTaskState(dir: string): void {
  const db = openHippoDb(dir);
  try {
    const snapshot = db.prepare(`INSERT INTO task_snapshots(task, summary, next_step, status, source, session_id, scope, tenant_id, created_at, updated_at, owner_subject, origin_project)
      VALUES (?, ?, ?, ?, 'cli', ?, ?, ?, ?, ?, ?, ?)`);
    for (const [tenant, task, status, session, scope, h, owner, origin] of SNAPSHOTS) {
      snapshot.run(task, `summary of ${task}`, `next step of ${task}`, status, session, scope, tenant, ago(hours(h) + 1), ago(hours(h)), owner, origin);
    }
    const handoff = db.prepare(`INSERT INTO session_handoffs(session_id, repo_root, task_id, summary, next_action, artifacts_json, scope, tenant_id, created_at,
      constraints_json, evidence_json, outcome, target_runtime, card_id, owner_subject, origin_project) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const [tenant, session, summary, outcome, scope, h, owner, origin] of HANDOFFS) {
      const full = summary === 'second handoff for session a';
      handoff.run(
        session, full ? '/repo' : null, full ? 'task-1' : null, summary, full ? 'ship it' : null, full ? '["a.ts","b.ts"]' : '[]', scope, tenant, ago(hours(h)),
        full ? '["no force push"]' : null, full ? '{"gitRef":"abc123","dirtyTree":false}' : null, outcome, full ? 'claude-code' : null, null, owner, origin,
      );
    }
    const event = db.prepare(`INSERT INTO session_events(session_id, task, event_type, content, source, scope, metadata_json, tenant_id, created_at)
      VALUES (?, NULL, 'note', ?, 'cli', ?, ?, ?, ?)`);
    for (const [tenant, session, content, scope, h, metadata] of EVENTS) event.run(session, content, scope, metadata, tenant, ago(hours(h)));
  } finally {
    closeHippoDb(db);
  }
}

// writeEntry stamps updated_at from SQLite's real clock and search breaks ties on it, so a golden needs one fixed stamp.
function pinUpdatedAt(dir: string): void {
  const db = openHippoDb(dir);
  try {
    db.prepare('UPDATE memories SET updated_at = ?').run('2026-03-10 00:00:00');
  } finally {
    closeHippoDb(db);
  }
}

/** Adds the context rows to a store folder that seedTwoTenants made. */
export function seedContextRows(dir: string): void {
  for (const row of memoryRows()) writeEntry(dir, row);
  insertTaskState(dir);
  pinUpdatedAt(dir);
}

/** A global store with a pin and a recent row in the first tenant, for the getContext runs that read one. */
export function seedContextGlobal(dir: string): void {
  initStore(dir);
  const a = inTenant(TENANT_A, '');
  writeEntry(dir, a('global pinned rule: rollout notes go in the team channel', 'mem_g_pin', 600, {}, { pinned: true }));
  writeEntry(dir, a('global rollout note from the home store', 'mem_g_note', 12));
  pinUpdatedAt(dir);
}

/** rowsOf, plus every column a retrieval strengthens. */
export function contextRowsOf(root: string) {
  const db = openHippoDb(root);
  try {
    return { ...rowsOf(root), strengthened: db.prepare('SELECT id, retrieval_count, last_retrieved, half_life_days, strength FROM memories ORDER BY id').all() };
  } finally {
    closeHippoDb(db);
  }
}

/** Each store sums ambient strength in its own order, so non-integers compare to nine places. */
export function rounded<T>(value: T): T {
  const text = JSON.stringify(value, (_k: string, v: JsonValue): JsonValue => (Number.isFinite(v) && !Number.isInteger(v) ? Math.round(Number(v) * 1e9) / 1e9 : v));
  // SAFETY: only numbers changed, so the JSON parses back to the shape it was written from.
  return JSON.parse(text) as T;
}
