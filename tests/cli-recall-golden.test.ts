// Pins `hippo recall` and `hippo explain` stdout, stderr and exit code over a flag matrix, plus the rows a recall
// writes, so a refactor of the recall pipeline that changes any byte fails here.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, Layer, type MemoryEntry } from '../src/memory.js';
import { pushGoal } from '../src/goals.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const SESSION = 'golden-session';
const DROP_ENV = ['HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'HIPPO_TENANT', 'HIPPO_ANCHORING', 'HIPPO_AVAILABILITY', 'HIPPO_HOME'];

let template: string;
let goalId = '';

function seeded(content: string, id: string, created: string, extra: Partial<MemoryEntry> = {}, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  // createMemory decays strength over the real milliseconds it runs, so a fixed value keeps snapshots stable.
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts }), id, created, last_retrieved: created, valid_from: created, strength: 1, ...extra };
}

function seedLocal(hippoRoot: string): void {
  initStore(hippoRoot);
  const rows: MemoryEntry[] = [
    seeded('deploy pipeline uses blue green rollout for the api', 'mem_golden_plain', '2026-01-20T00:00:00.000Z', {}, { tags: ['deploy'] }),
    seeded('deploy freeze applies to the billing service on fridays', 'mem_golden_pinned', '2026-01-05T00:00:00.000Z', {}, { pinned: true, tags: ['deploy', 'billing'] }),
    seeded('deploy checklist for team alpha runs smoke tests first', 'mem_golden_scoped', '2026-01-18T00:00:00.000Z', {}, { scope: 'team-alpha', tags: ['deploy'] }),
    seeded('private deploy token rotation lives in slack', 'mem_golden_private', '2026-01-19T00:00:00.000Z', {}, { scope: 'slack:private:C1' }),
    seeded('deploy target was the old staging cluster', 'mem_golden_old', '2026-01-02T00:00:00.000Z', { superseded_by: 'mem_golden_new' }),
    seeded('deploy target is the new staging cluster in eu west', 'mem_golden_new', '2026-01-25T00:00:00.000Z', { conflicts_with: ['mem_golden_plain'] }),
    seeded('deploy goal work: migrate the rollout scripts to the new runner', 'mem_golden_goal', '2026-01-15T00:00:00.000Z', { retrieval_count: 3, outcome_positive: 2 }, { tags: ['goal-alpha'] }),
    seeded('deploy trace: ran the canary and promoted it', 'mem_golden_trace', '2026-01-22T00:00:00.000Z', {}, { layer: Layer.Trace, trace_outcome: 'success' }),
    seeded('unrelated note about lunch options near the office', 'mem_golden_noise', '2026-01-21T00:00:00.000Z'),
  ];
  for (const row of rows) writeEntry(hippoRoot, row);
  goalId = pushGoal(hippoRoot, { sessionId: SESSION, tenantId: 'default', goalName: 'goal-alpha' }).id;
}

function seedGlobal(globalRoot: string): void {
  initStore(globalRoot);
  writeEntry(globalRoot, seeded('deploy notes from the global store about rollbacks', 'mem_golden_global', '2026-01-12T00:00:00.000Z'));
}

interface Case { name: string; args: string[]; global?: boolean; session?: boolean }

const CASES: Case[] = [
  { name: 'recall default', args: ['recall', 'deploy'] },
  { name: 'recall --json', args: ['recall', 'deploy', '--json'] },
  { name: 'recall --why', args: ['recall', 'deploy', '--why'] },
  { name: 'recall --why --json', args: ['recall', 'deploy', '--why', '--json'] },
  { name: 'recall --scope private', args: ['recall', 'deploy', '--scope', 'slack:private:C1', '--json'] },
  { name: 'recall --scope tag', args: ['recall', 'deploy', '--scope', 'team-alpha'] },
  { name: 'recall --limit 2', args: ['recall', 'deploy', '--limit', '2'] },
  { name: 'recall --budget 120', args: ['recall', 'deploy', '--budget', '120', '--why'] },
  { name: 'recall --physics', args: ['recall', 'deploy', '--physics', '--json'] },
  { name: 'recall --classic', args: ['recall', 'deploy', '--classic', '--json'] },
  { name: 'recall --multihop', args: ['recall', 'deploy', '--multihop', '--json'] },
  { name: 'recall --graph-stream', args: ['recall', 'deploy', '--graph-stream', '--graph-hops', '2', '--graph-seeds', '3'] },
  { name: 'recall --hops 1', args: ['recall', 'deploy', '--hops', '1', '--max-neighbors', '5', '--json'] },
  { name: 'recall --include-superseded', args: ['recall', 'deploy', '--include-superseded', '--json'] },
  { name: 'recall --as-of', args: ['recall', 'deploy', '--as-of', '2026-01-10', '--json'] },
  { name: 'recall --goal', args: ['recall', 'deploy', '--goal', 'goal-alpha', '--why'] },
  { name: 'recall session goal stack', args: ['recall', 'deploy', '--why', '--json'], session: true },
  { name: 'recall pfc rerankers', args: ['recall', 'deploy', '--why', '--json', '--evc-adaptive', '--filter-conflicts', '--include-superseded', '--value-aware', '--rerank-utility', '--salience-threshold', '2'] },
  { name: 'recall --outcome success', args: ['recall', 'deploy', '--outcome', 'success', '--json'] },
  { name: 'recall --layer trace', args: ['recall', 'deploy', '--layer', 'trace'] },
  { name: 'recall no match', args: ['recall', 'zzqqxx'] },
  { name: 'recall no match --json', args: ['recall', 'zzqqxx', '--json'] },
  { name: 'recall global store', args: ['recall', 'deploy'], global: true },
  { name: 'recall global store --json --why', args: ['recall', 'deploy', '--json', '--why'], global: true },
  { name: 'recall invalid --layer', args: ['recall', 'deploy', '--layer', 'bogus'] },
  { name: 'recall invalid --outcome', args: ['recall', 'deploy', '--outcome', 'nope'] },
  { name: 'recall invalid --salience-threshold', args: ['recall', 'deploy', '--salience-threshold', '-1'] },
  { name: 'recall invalid --hops', args: ['recall', 'deploy', '--hops', 'x'] },
  { name: 'recall invalid --max-neighbors', args: ['recall', 'deploy', '--hops', '1', '--max-neighbors', '0'] },
  { name: 'recall invalid --as-of', args: ['recall', 'deploy', '--as-of', 'notadate'] },
  { name: 'recall invalid --graph-hops', args: ['recall', 'deploy', '--graph-stream', '--graph-hops', '0'] },
  { name: 'recall invalid --graph-seeds', args: ['recall', 'deploy', '--graph-stream', '--graph-seeds', 'x'] },
  { name: 'recall invalid --reranker', args: ['recall', 'deploy', '--reranker', 'bogus'] },
  { name: 'recall graph-stream note then invalid --layer', args: ['recall', 'deploy', '--graph-stream', '--layer', 'bogus'], global: true },
  { name: 'explain default', args: ['explain', 'deploy'] },
  { name: 'explain --json', args: ['explain', 'deploy', '--json'] },
  { name: 'explain --scope private --json', args: ['explain', 'deploy', '--scope', 'slack:private:C1', '--json'] },
  { name: 'explain --include-superseded --classic', args: ['explain', 'deploy', '--include-superseded', '--classic', '--limit', '3'] },
  { name: 'explain global store', args: ['explain', 'deploy'], global: true },
  { name: 'explain no match', args: ['explain', 'zzqqxx'] },
];

// Whether Node prints the SQLite warning depends on its version, so it stays out of the snapshot.
const SQLITE_WARNING = /\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature[^\n]*\r?\n\(Use `node --trace-warnings[^\n]*(?:\r?\n)?/g;

function normalise(text: string, home: string): string {
  return text
    .replace(SQLITE_WARNING, '')
    .split(home).join('<home>')
    .split(home.replace(/\\/g, '/')).join('<home>')
    .split(goalId).join('<goal>')
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
}

interface FreshStore { home: string; env: NodeJS.ProcessEnv }

function freshStore(c: Pick<Case, 'global'>): FreshStore {
  const home = mkdtempSync(join(tmpdir(), 'hippo-golden-'));
  cpSync(template, join(home, '.hippo'), { recursive: true });
  const globalRoot = join(home, 'global-hippo');
  if (c.global) seedGlobal(globalRoot);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  Object.assign(env, { HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_FAKE_NOW: FAKE_NOW });
  return { home, env };
}

interface RunOutput { status: number | null; stdout: string; stderr: string }
interface RunResult { home: string; out: RunOutput }

function run(c: Case): RunResult {
  const { home, env } = freshStore(c);
  if (c.session) env.HIPPO_SESSION_ID = SESSION;
  const res = spawnSync('node', [CLI, ...c.args], { cwd: home, env, encoding: 'utf-8' });
  return { home, out: { status: res.status, stdout: normalise(res.stdout, home), stderr: normalise(res.stderr, home) } };
}

interface WrittenRows {
  audit: unknown[]; goalRecallLog: unknown[]; stats: unknown[]; traces: unknown[];
  traceResults: unknown[]; ledger: unknown[]; memories: unknown[];
}

function writtenRows(hippoRoot: string): WrittenRows {
  const db = openHippoDb(hippoRoot);
  try {
    const q = (sql: string): unknown[] => db.prepare(sql).all();
    return {
      audit: q('SELECT ts, tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY id'),
      goalRecallLog: q('SELECT goal_id, memory_id, tenant_id, session_id, recalled_at, score FROM goal_recall_log ORDER BY memory_id, goal_id'),
      stats: q("SELECT key, value FROM meta WHERE key LIKE 'total_%' ORDER BY key"),
      traces: q('SELECT id, ts, tenant_id, session_id, pipeline, query_hash, query_length, result_count, explain_mode FROM recall_traces ORDER BY id'),
      traceResults: q('SELECT trace_id, memory_id, result_rank, score, rerank_json FROM recall_trace_results ORDER BY trace_id, result_rank'),
      ledger: q('SELECT ts, tenant_id, session_id, surface, event, items, tokens FROM token_ledger ORDER BY id'),
      memories: q('SELECT id, retrieval_count, strength, last_retrieved FROM memories ORDER BY id'),
    };
  } finally {
    closeHippoDb(db);
  }
}

interface RowsAfter<T> { status: number | null; rows: T }

function rowsAfter<T>(c: Case, pick: (rows: WrittenRows) => T): RowsAfter<T> {
  const { home, out } = run(c);
  try {
    const rows = pick(writtenRows(join(home, '.hippo')));
    return { status: out.status, rows: JSON.parse(normalise(JSON.stringify(rows), home)) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('cli recall and explain golden output', () => {
  beforeAll(() => {
    template = join(mkdtempSync(join(tmpdir(), 'hippo-golden-template-')), '.hippo');
    seedLocal(template);
  });

  afterAll(() => {
    if (template) rmSync(join(template, '..'), { recursive: true, force: true });
  });

  it.each(CASES)('$name', (c) => {
    const { home, out } = run(c);
    try {
      expect(out).toMatchSnapshot();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it('rows one goal-stack recall writes', () => {
    const got = rowsAfter({ name: 'writes', args: ['recall', 'deploy', '--json', '--why'], session: true }, (rows) => rows);
    expect(got.status).toBe(0);
    expect(got.rows).toMatchSnapshot();
  }, 60_000);

  it('rows a goal-stack recall with an invalid late flag writes', () => {
    const got = rowsAfter(
      { name: 'late-invalid', args: ['recall', 'deploy', '--layer', 'bogus'], session: true },
      (rows) => ({ goalRecallLog: rows.goalRecallLog, audit: rows.audit, traces: rows.traces }),
    );
    expect(got.status).toBe(1);
    expect(got.rows).toMatchSnapshot();
  }, 60_000);
});
