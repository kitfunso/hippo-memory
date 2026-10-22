// Pins the published stdout, stderr and exit code of `hippo recall` and `hippo explain` over a flag matrix, and asserts
// the rows a goal-stack recall writes. The cases in SPAWNED run the built CLI; the rest run it in process.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Layer, type MemoryEntry } from '../../src/base/memory/memory.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { ownStderr } from '../_helpers/own-stderr.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot, makeStore } from '../_helpers/make-root.js';
import { pushGoal, writeEntry } from '../_helpers/root-forms.js';
import { seeded } from '../_helpers/recall-golden-seed.js';
import { initTestStore } from '../_helpers/store-template.js';

const CLI = join(process.cwd(), 'dist', 'cli.js');
const FAKE_NOW = '2026-02-01T00:00:00.000Z';
const SESSION = 'golden-session';
const DROP_ENV = [
  'HIPPO_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'HIPPO_TENANT',
  'HIPPO_ANCHORING',
  'HIPPO_AVAILABILITY',
  'HIPPO_HOME',
];

// One case per verb pins that the built CLI prints the bytes the in-process run does.
const SPAWNED = new Set(['recall default', 'explain default']);

let template: string;
let goalId = '';

async function seedLocal(hippoRoot: string): Promise<void> {
  const rows: MemoryEntry[] = [
    seeded(
      'deploy pipeline uses blue green rollout for the api',
      'mem_golden_plain',
      '2026-01-20T00:00:00.000Z',
      {},
      { tags: ['deploy'] },
    ),
    seeded(
      'deploy freeze applies to the billing service on fridays',
      'mem_golden_pinned',
      '2026-01-05T00:00:00.000Z',
      {},
      { pinned: true, tags: ['deploy', 'billing'] },
    ),
    seeded(
      'deploy checklist for team alpha runs smoke tests first',
      'mem_golden_scoped',
      '2026-01-18T00:00:00.000Z',
      {},
      { scope: 'team-alpha', tags: ['deploy'] },
    ),
    seeded(
      'private deploy token rotation lives in slack',
      'mem_golden_private',
      '2026-01-19T00:00:00.000Z',
      {},
      { scope: 'slack:private:C1' },
    ),
    seeded('deploy target was the old staging cluster', 'mem_golden_old', '2026-01-02T00:00:00.000Z', {
      supersededBy: 'mem_golden_new',
    }),
    seeded('deploy target is the new staging cluster in eu west', 'mem_golden_new', '2026-01-25T00:00:00.000Z', {
      conflictsWith: ['mem_golden_plain'],
    }),
    seeded(
      'deploy goal work: migrate the rollout scripts to the new runner',
      'mem_golden_goal',
      '2026-01-15T00:00:00.000Z',
      { retrievalCount: 3, outcomePositive: 2 },
      { tags: ['goal-alpha'] },
    ),
    seeded(
      'deploy trace: ran the canary and promoted it',
      'mem_golden_trace',
      '2026-01-22T00:00:00.000Z',
      {},
      { layer: Layer.Trace, traceOutcome: 'success' },
    ),
    seeded('unrelated note about lunch options near the office', 'mem_golden_noise', '2026-01-21T00:00:00.000Z'),
  ];
  for (const row of rows) writeEntry(hippoRoot, row);
  goalId = (await pushGoal(hippoRoot, { sessionId: SESSION, tenantId: 'default', goalName: 'goal-alpha' })).id;
}

function seedGlobal(globalRoot: string): void {
  writeEntry(
    globalRoot,
    seeded('deploy notes from the global store about rollbacks', 'mem_golden_global', '2026-01-12T00:00:00.000Z'),
  );
}

interface Case {
  name: string;
  args: string[];
  global?: boolean;
  session?: boolean;
}

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
  {
    name: 'recall --graph-stream',
    args: ['recall', 'deploy', '--graph-stream', '--graph-hops', '2', '--graph-seeds', '3'],
  },
  { name: 'recall --hops 1', args: ['recall', 'deploy', '--hops', '1', '--max-neighbors', '5', '--json'] },
  { name: 'recall --include-superseded', args: ['recall', 'deploy', '--include-superseded', '--json'] },
  { name: 'recall --as-of', args: ['recall', 'deploy', '--as-of', '2026-01-10', '--json'] },
  { name: 'recall --goal', args: ['recall', 'deploy', '--goal', 'goal-alpha', '--why'] },
  { name: 'recall session goal stack', args: ['recall', 'deploy', '--why', '--json'], session: true },
  {
    name: 'recall pfc rerankers',
    args: [
      'recall',
      'deploy',
      '--why',
      '--json',
      '--evc-adaptive',
      '--filter-conflicts',
      '--include-superseded',
      '--value-aware',
      '--rerank-utility',
      '--salience-threshold',
      '2',
    ],
  },
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
  {
    name: 'recall graph-stream note then invalid --layer',
    args: ['recall', 'deploy', '--graph-stream', '--layer', 'bogus'],
    global: true,
  },
  { name: 'explain default', args: ['explain', 'deploy'] },
  { name: 'explain --json', args: ['explain', 'deploy', '--json'] },
  { name: 'explain --scope private --json', args: ['explain', 'deploy', '--scope', 'slack:private:C1', '--json'] },
  {
    name: 'explain --include-superseded --classic',
    args: ['explain', 'deploy', '--include-superseded', '--classic', '--limit', '3'],
  },
  { name: 'explain global store', args: ['explain', 'deploy'], global: true },
  { name: 'explain no match', args: ['explain', 'zzqqxx'] },
];

function normalize(text: string, home: string): string {
  return ownStderr(text)
    .split(home)
    .join('<home>')
    .split(home.replace(/\\/g, '/'))
    .join('<home>')
    .split(goalId)
    .join('<goal>')
    .replace(/\(node:\d+\)/g, '(node:<pid>)')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
}

interface FreshStore {
  home: string;
  env: NodeJS.ProcessEnv;
}

function freshStore(c: Pick<Case, 'global'>): FreshStore {
  const home = makeRoot('golden', { init: false });
  cpSync(template, join(home, '.hippo'), { recursive: true });
  const globalRoot = join(home, 'global-hippo');
  if (c.global) {
    initTestStore(globalRoot);
    seedGlobal(globalRoot);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DROP_ENV) delete env[k];
  Object.assign(env, { HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1', HIPPO_FAKE_NOW: FAKE_NOW });
  return { home, env };
}

interface RunOutput {
  status: number | null;
  stdout: string;
  stderr: string;
}
interface RunResult {
  home: string;
  out: RunOutput;
}

async function run(c: Case): Promise<RunResult> {
  const { home, env } = freshStore(c);
  if (c.session) env.HIPPO_SESSION_ID = SESSION;
  const res = SPAWNED.has(c.name)
    ? spawnSync('node', [CLI, ...c.args], { cwd: home, env, encoding: 'utf-8' })
    : await runCliAs(c.args, { cwd: home, env });
  return {
    home,
    out: { status: res.status, stdout: normalize(res.stdout, home), stderr: normalize(res.stderr, home) },
  };
}

type Row = Record<string, string | number | null>;

interface WrittenRows {
  audit: Row[];
  goalRecallLog: Row[];
  stats: Row[];
  traces: Row[];
  traceResults: Row[];
  ledger: Row[];
  memories: Row[];
}

function writtenRows(hippoRoot: string): WrittenRows {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: node:sqlite answers each row as a plain column-keyed object.
    const q = (sql: string): Row[] => db.prepare(sql).all() as Row[];
    return {
      audit: q('SELECT ts, tenant_id, actor, op, target_id, metadata_json FROM audit_log ORDER BY id'),
      goalRecallLog: q(
        'SELECT goal_id, memory_id, tenant_id, session_id, recalled_at, score FROM goal_recall_log ORDER BY memory_id, goal_id',
      ),
      stats: q("SELECT key, value FROM meta WHERE key LIKE 'total_%' ORDER BY key"),
      traces: q(
        'SELECT id, ts, tenant_id, session_id, pipeline, query_hash, query_length, result_count, explain_mode FROM recall_traces ORDER BY id',
      ),
      traceResults: q(
        'SELECT trace_id, memory_id, result_rank, score, rerank_json FROM recall_trace_results ORDER BY trace_id, result_rank',
      ),
      ledger: q('SELECT ts, tenant_id, session_id, surface, event, items, tokens FROM token_ledger ORDER BY id'),
      memories: q('SELECT id, retrieval_count, strength, last_retrieved FROM memories ORDER BY id'),
    };
  } finally {
    closeHippoDb(db);
  }
}

interface RowsAfter {
  status: number | null;
  rows: WrittenRows;
}

async function rowsAfter(c: Case): Promise<RowsAfter> {
  const { home, out } = await run(c);
  try {
    const rows = writtenRows(join(home, '.hippo'));
    // SAFETY: normalize rewrites text inside the JSON strings only, so the parse keeps the WrittenRows shape.
    return { status: out.status, rows: JSON.parse(normalize(JSON.stringify(rows), home)) as WrittenRows };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const SHOWN = ['goal', 'plain', 'scoped', 'pinned', 'trace', 'new'].map((n) => `mem_golden_${n}`);
// The seed's own writes, one audit row per seeded memory.
const SEEDED = ['plain', 'pinned', 'scoped', 'private', 'old', 'new', 'goal', 'trace', 'noise'].map(
  (n) => `remember mem_golden_${n}`,
);
const auditOps = (rows: WrittenRows): string[] =>
  rows.audit.map((a) => `${String(a['op'])} ${String(a['target_id'] ?? '-')}`);
const goalLogged = (score: number) => ({
  goal_id: '<goal>',
  memory_id: 'mem_golden_goal',
  tenant_id: 'default',
  session_id: SESSION,
  recalled_at: '<ts>',
  score,
});

describe('cli recall and explain golden output', () => {
  beforeAll(async () => {
    template = makeStore('golden-template').root;
    await seedLocal(template);
  });

  it.each(CASES)('$name', async (c) => {
    const { home, out } = await run(c);
    try {
      expect(out).toMatchSnapshot();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rows one goal-stack recall writes', async () => {
    const { status, rows } = await rowsAfter({
      name: 'writes',
      args: ['recall', 'deploy', '--json', '--why'],
      session: true,
    });
    expect(status).toBe(0);
    expect(auditOps(rows)).toEqual([...SEEDED, 'recall -']);
    const trace = { tenant_id: 'default', session_id: SESSION, pipeline: 'cli', query_length: 6, result_count: 6 };
    expect(rows.traces).toEqual([expect.objectContaining({ ...trace, explain_mode: 1 })]);
    expect(JSON.parse(String(rows.audit.at(-1)!['metadata_json']))).toEqual({
      query_hash: rows.traces[0]!['query_hash'],
      query_length: 6,
      results: 6,
    });
    // The session goal doubles its row's score, which lifts it to the top; no other stage reranks.
    expect(rows.traceResults.map((t) => [t['result_rank'], t['memory_id']])).toEqual(SHOWN.map((id, i) => [i + 1, id]));
    const scores = rows.traceResults.map((t) => Number(t['score']));
    expect(scores.every((s, i) => s > 0 && (i === 0 || s < scores[i - 1]!))).toBe(true);
    const reranks = rows.traceResults.map((t) =>
      // SAFETY: rerank_json holds a JSON array of flat stage objects.
      t['rerank_json'] === null ? null : (JSON.parse(String(t['rerank_json'])) as Row[]),
    );
    expect(reranks.slice(1)).toEqual(SHOWN.slice(1).map(() => null));
    expect(reranks[0]).toEqual([
      { stage: 'goal-boost', multiplier: 2, scoreBefore: expect.any(Number), scoreAfter: scores[0] },
    ]);
    expect(Number(reranks[0]![0]!['scoreAfter'])).toBeCloseTo(2 * Number(reranks[0]![0]!['scoreBefore']), 12);
    expect(rows.goalRecallLog).toEqual([goalLogged(scores[0]!)]);
    expect(rows.ledger).toEqual([
      {
        ts: '<ts>',
        tenant_id: 'default',
        session_id: SESSION,
        surface: 'recall',
        event: 'inject',
        items: 6,
        tokens: expect.any(Number),
      },
    ]);
    expect(Number(rows.ledger[0]!['tokens'])).toBeGreaterThan(0);
    expect(rows.stats).toEqual([
      { key: 'total_forgotten', value: '0' },
      { key: 'total_recalled', value: '6' },
      { key: 'total_remembered', value: '0' },
    ]);
    // Each shown row counts one retrieval; the goal row's seed starts at 3.
    const counts = Object.fromEntries(rows.memories.map((m) => [m['id'], m['retrieval_count']]));
    expect(counts).toEqual({
      ...Object.fromEntries(['noise', 'old', 'private'].map((n) => [`mem_golden_${n}`, 0])),
      ...Object.fromEntries(SHOWN.map((id) => [id, id === 'mem_golden_goal' ? 4 : 1])),
    });
    expect(rows.memories.every((m) => m['strength'] === 1)).toBe(true);
  });

  it('rows a goal-stack recall with an invalid late flag writes', async () => {
    const { status, rows } = await rowsAfter({
      name: 'late-invalid',
      args: ['recall', 'deploy', '--layer', 'bogus'],
      session: true,
    });
    expect(status).toBe(1);
    // The goal stage logs its row before the late flag is checked; nothing after that point writes.
    expect(rows.goalRecallLog).toEqual([goalLogged(expect.any(Number))]);
    expect(Number(rows.goalRecallLog[0]!['score'])).toBeGreaterThan(0);
    expect(auditOps(rows)).toEqual(SEEDED);
    expect([rows.traces, rows.traceResults, rows.ledger]).toEqual([[], [], []]);
  });
});
