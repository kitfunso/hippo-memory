// The recall golden seed: one local store, one wide store and one global store, copied fresh for each test,
// so the surface goldens, the port-only parity test and the sqliteStore tests replay the same rows.
import { vi } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../../src/memory.js';
import { pushGoal } from '../../src/goals.js';
import { openHippoDb, closeHippoDb } from '../../src/db.js';
import { appendSessionEvent, saveActiveTaskSnapshot } from '../../src/store/sessions.js';
import { saveSessionHandoff } from '../../src/store/handoffs.js';
import { closePrediction, savePrediction } from '../../src/predictions/store.js';

export const FAKE_NOW = '2026-02-01T00:00:00.000Z';
export const SESSION = 'golden-session';
export const TENANT = 'default';
export const CLEARED_ENV = [
  'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_TENANT', 'HIPPO_ANCHORING', 'HIPPO_AVAILABILITY', 'HIPPO_AUTODEBIAS',
  'HIPPO_SCOPE', 'GSTACK_SKILL', 'OPENCLAW_SKILL', 'HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL', 'HIPPO_REQUIRE_AUTH',
  'HIPPO_API_KEY', 'HIPPO_ABLATE_RECALL_BOOST',
];

/** Bad and edge recall inputs, keyed by MCP argument name; HTTP sends `query` as `q`. */
export const RECALL_INPUTS: readonly [string, Record<string, string | number | boolean>][] = [
  ['empty query', { query: '' }],
  ['scorer_window 0', { query: 'deploy', scorer_window: 0 }],
  ['scorer_window 5000', { query: 'deploy', scorer_window: 5000 }],
  ['scorer_window abc', { query: 'deploy', scorer_window: 'abc' }],
  ['fresh_tail_count -1', { query: 'deploy', fresh_tail_count: -1 }],
  ['fresh_tail_count abc', { query: 'deploy', fresh_tail_count: 'abc' }],
  ['fresh_tail_session_id 300 chars', { query: 'deploy', fresh_tail_count: 1, fresh_tail_session_id: 'f'.repeat(300) }],
  ['session_id 300 chars', { query: 'deploy', session_id: 's'.repeat(300) }],
  ['session_id blank', { query: 'deploy', session_id: '   ' }],
  ['summarize_overflow banana', { query: 'deploy', summarize_overflow: 'banana' }],
  ['scope empty', { query: 'deploy', scope: '' }],
  ['budget -1', { query: 'deploy', budget: -1 }],
  ['mode bogus', { query: 'deploy', mode: 'bogus' }],
  ['limit 0', { query: 'deploy', limit: 0 }],
];

export function seeded(content: string, id: string, created: string, extra: Partial<MemoryEntry> = {}, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  // createMemory decays strength over the real milliseconds it runs, so a fixed value keeps snapshots stable.
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts }), id, created, last_retrieved: created, valid_from: created, strength: 1, ...extra };
}

/** Seeds the local store and returns the id of its active goal. */
function seedLocal(root: string): string {
  initStore(root);
  const rows: MemoryEntry[] = [
    seeded('deploy pipeline uses blue green rollout for the api', 'mem_p_plain', '2026-01-20T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('deploy freeze applies to the billing service on fridays', 'mem_p_pinned', '2026-01-05T00:00:00.000Z', {}, { pinned: true, tags: ['deploy'] }),
    seeded('deploy checklist for team alpha runs smoke tests first', 'mem_p_scoped', '2026-01-18T00:00:00.000Z', {}, { scope: 'team-alpha' }),
    seeded('private deploy token rotation lives in slack', 'mem_p_private', '2026-01-19T00:00:00.000Z', {}, { scope: 'slack:private:C1' }),
    seeded('deploy target was the old staging cluster', 'mem_p_old', '2026-01-02T00:00:00.000Z', { superseded_by: 'mem_p_new' }),
    seeded('deploy target is the new staging cluster in eu west', 'mem_p_new', '2026-01-25T00:00:00.000Z'),
    seeded('deploy goal work: migrate the rollout scripts to the new runner', 'mem_p_goal', '2026-01-15T00:00:00.000Z', { retrieval_count: 3 }, { tags: ['goal-alpha'] }),
    seeded('deploy trace: ran the canary and promoted it', 'mem_p_trace', '2026-01-22T00:00:00.000Z', {}, { layer: Layer.Trace, trace_outcome: 'success' }),
    seeded('unrelated note about lunch options near the office', 'mem_p_noise', '2026-01-21T00:00:00.000Z'),
  ];
  for (let i = 0; i < 6; i++) {
    rows.push(seeded(`deploy log line ${i} for the nightly batch`, `mem_p_fill${i}`, `2026-01-1${i}T00:00:00.000Z`));
  }
  for (const row of rows) writeEntry(root, row);
  return pushGoal(root, { sessionId: SESSION, tenantId: TENANT, goalName: 'goal-alpha' }).id;
}

function seedWide(root: string): void {
  initStore(root);
  for (let i = 0; i < 230; i++) {
    writeEntry(root, seeded(`deploy step ${i} of the wide rollout`, `mem_w_${String(i).padStart(3, '0')}`, '2026-01-10T00:00:00.000Z'));
  }
}

function seedGlobal(root: string): void {
  initStore(root);
  writeEntry(root, seeded('deploy notes from the global store about rollbacks', 'mem_p_global', '2026-01-12T00:00:00.000Z'));
}

/** The rows the golden seed lacks: a level-2 summary over two deploy rows, a café row, a session raw row, continuity and a closed prediction. */
export function seedPortBranches(root: string): void {
  const summary = seeded('rollout summary for the nightly batch move', 'mem_x_summary', '2026-01-08T00:00:00.000Z', { dag_level: 2 }, { layer: Layer.Semantic, tags: ['dag-summary'] });
  const rows = [
    summary,
    seeded('deploy batch child one moved the cron', 'mem_x_child1', '2026-01-03T00:00:00.000Z', { dag_level: 1, dag_parent_id: summary.id }),
    seeded('deploy batch child two moved the queue', 'mem_x_child2', '2026-01-04T00:00:00.000Z', { dag_level: 1, dag_parent_id: summary.id }),
    seeded('café opening hours for the team lunch', 'mem_x_cafe', '2026-01-06T00:00:00.000Z'),
    seeded('raw capture of the deploy window from the golden session', 'mem_x_raw', '2026-01-24T00:00:00.000Z', { kind: 'raw', source_session_id: SESSION }),
  ];
  for (const row of rows) writeEntry(root, row);
  saveActiveTaskSnapshot(root, TENANT, { task: 'ship the eu cluster', summary: 'cutover planned', next_step: 'run the canary', session_id: SESSION });
  saveSessionHandoff(root, TENANT, { version: 1, sessionId: SESSION, summary: 'handoff after the canary', nextAction: 'promote it' });
  appendSessionEvent(root, TENANT, { session_id: SESSION, event_type: 'note', content: 'canary passed' });
  const prediction = savePrediction(root, TENANT, { classTag: 'deploy-duration', claimText: 'rollout duration estimate for the eu cluster', estimateValue: 3 });
  closePrediction(root, TENANT, prediction.id, { closureState: 'closed', actualValue: 5 });
}

/** writeEntry stamps updated_at from SQLite's real clock and recall breaks bm25 ties on it, so one stamp keeps the order fixed. */
function pinUpdatedAt(root: string): void {
  const db = openHippoDb(root);
  try {
    db.prepare('UPDATE memories SET updated_at = ?').run('2026-02-01 00:00:00');
  } finally {
    closeHippoDb(db);
  }
}

export interface Templates { dir: string; goalId: string }

/** Seeds the three template stores once per file; `extendLocal` adds rows to the local store before the stamps are pinned. */
export function seedTemplates(extendLocal?: (root: string) => void): Templates {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-parity-template-'));
  const goalId = seedLocal(join(dir, 'local'));
  extendLocal?.(join(dir, 'local'));
  seedWide(join(dir, 'wide'));
  seedGlobal(join(dir, 'global'));
  for (const kind of ['local', 'wide', 'global']) pinUpdatedAt(join(dir, kind));
  return { dir, goalId };
}

export interface Store { home: string; root: string; globalRoot: string; goalId: string }

/** A fresh copy of a template store plus the global store, with HIPPO_HOME pointed at that global store. */
export function freshStore(templates: Templates, kind: 'local' | 'wide'): Store {
  const home = mkdtempSync(join(tmpdir(), 'hippo-parity-'));
  const root = join(home, 'store');
  const globalRoot = join(home, 'global');
  cpSync(join(templates.dir, kind), root, { recursive: true });
  cpSync(join(templates.dir, 'global'), globalRoot, { recursive: true });
  vi.stubEnv('HIPPO_HOME', globalRoot);
  return { home, root, globalRoot, goalId: templates.goalId };
}

export function normalise<T>(value: T, s: Store): T {
  const text = JSON.stringify(value)
    .split(JSON.stringify(s.home).slice(1, -1)).join('<home>')
    .split(s.home.replace(/\\/g, '/')).join('<home>')
    .split(s.goalId).join('<goal>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
  // SAFETY: text is the JSON of a T with only string contents rewritten, so it parses back to the same shape.
  return JSON.parse(text) as T;
}

/** Every row one recall writes: audit, goal log, stats, traces, token ledger and retrieval counters. */
export function rowsOf(root: string) {
  const db = openHippoDb(root);
  try {
    const q = (sql: string): unknown[] => db.prepare(sql).all();
    return {
      audit: q("SELECT ts, tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'recall%' ORDER BY id"),
      goalRecallLog: q('SELECT goal_id, memory_id, session_id, score FROM goal_recall_log ORDER BY memory_id'),
      stats: q("SELECT key, value FROM meta WHERE key LIKE 'total_%' ORDER BY key"),
      traces: q('SELECT id, tenant_id, session_id, pipeline, result_count, explain_mode FROM recall_traces ORDER BY id'),
      traceResults: q('SELECT trace_id, memory_id, result_rank, score FROM recall_trace_results ORDER BY trace_id, result_rank'),
      ledger: q('SELECT tenant_id, session_id, surface, event, items, tokens FROM token_ledger ORDER BY id'),
      retrieved: q('SELECT id, retrieval_count, strength FROM memories WHERE retrieval_count > 0 ORDER BY id'),
    };
  } finally {
    closeHippoDb(db);
  }
}
