// `hippo context` without --pinned-only through the built CLI: its delivery_events row and the recall trace it links.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { blockHash, estimateTokens } from '../src/util/token-text.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { initStore } from '../src/store/open.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import {
  PROMPT_HOOK, dispose, eventCount, eventsN, hippo, project, promptPayload, tableRows, writeConfig, type Project,
} from './_helpers/delivery-boundary.js';

// After every seeded `created`, real or fixed, so no memory is dated in the future.
const FAKE_NOW = '2099-01-01T00:00:00.000Z';
const QUERY = ['postgres', 'migration', 'rollback'];

let p: Project;

function seedFacts(target: Project): void {
  const facts = [
    'the postgres migration needs a rollback plan and a dry run',
    'the postgres rollback runs the down migration before the deploy',
    'deploy windows are Tuesday and Thursday afternoons only',
  ];
  facts.forEach((content, i) => {
    writeEntry(target.hippoRoot, {
      ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
      id: `mem_ctx_fact_${i}`, created: '2026-05-20T00:00:00.000Z', last_retrieved: '2026-05-20T00:00:00.000Z',
    });
  });
}

const run = (target: Project, args: string[], sessionId: string | null = 'ctx-1') =>
  hippo(target, ['context', ...args], { env: { HIPPO_FAKE_NOW: FAKE_NOW, ...(sessionId === null ? {} : { CLAUDE_CODE_SESSION_ID: sessionId }) } });

interface TraceRow { id: number; query_hash: string }

function contextTraces(target: Project): TraceRow[] {
  // SAFETY: the SELECT names exactly the two TraceRow columns.
  return tableRows(target, `SELECT id, query_hash FROM recall_traces WHERE pipeline = 'context' ORDER BY id`) as unknown as TraceRow[];
}

function traceResultIds(target: Project, traceId: number): string[] {
  return tableRows(target, `SELECT memory_id FROM recall_trace_results WHERE trace_id = ${traceId} ORDER BY result_rank`).map((r) => String(r.memory_id));
}

beforeEach(() => {
  p = project();
  seedFacts(p);
});

afterEach(() => {
  dispose(p);
});

describe('what one hippo context call records', () => {
  it('C1: a query leaves one sent context row that links the trace the call wrote', () => {
    const r = run(p, QUERY);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('rollback plan');
    const [e] = eventsN(p, 'ctx-1', 1);
    expect([e.event_type, e.surface, e.runtime, e.session_state, e.turn_seq, e.block_state, e.ledger_version])
      .toEqual(['context', 'context', 'unknown', 'env', 1, 'sent', 3]);
    expect([e.emitted_hash, e.injected_tokens]).toEqual([blockHash(r.stdout), estimateTokens(r.stdout)]);
    const [trace] = contextTraces(p);
    expect([e.recall_trace_id, e.query_hash]).toEqual([trace.id, trace.query_hash]);
    expect(e.query_hash).toBe(blockHash(QUERY.join(' ')));
    const emitted = e.candidates.filter((c) => c.outcome === 'emitted');
    expect(emitted.map((c) => c.memory_id)).toEqual(traceResultIds(p, trace.id));
    expect(new Set(emitted.map((c) => c.pool))).toEqual(new Set(['search']));
    expect([e.prompt_hash, e.host_turn_id, e.selected_count]).toEqual([null, null, emitted.length]);
  });

  it('C2: no query ranks by strength, so the row and its trace carry the hash of * and pool strength', () => {
    const r = run(p, []);
    expect(r.status, r.stderr).toBe(0);
    const [e] = eventsN(p, 'ctx-1', 1);
    const [trace] = contextTraces(p);
    expect([e.block_state, e.recall_trace_id, e.query_hash]).toEqual(['sent', trace.id, blockHash('*')]);
    expect(e.candidates.length).toBeGreaterThan(0);
    expect(new Set(e.candidates.map((c) => c.pool))).toEqual(new Set(['strength']));
  });

  it('C3: a query that returns nothing writes an empty trace, which the empty row joins by query hash, not by id', () => {
    const r = run(p, ['zzqxv', 'wplmk']);
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'ctx-1', 1);
    const [trace] = contextTraces(p);
    expect(traceResultIds(p, trace.id)).toEqual([]);
    expect([e.block_state, e.recall_trace_id, e.query_hash, e.candidates]).toEqual(['empty', null, trace.query_hash, []]);
    expect(e.query_hash).toBe(blockHash('zzqxv wplmk'));
  });

  it('C4: a store with nothing to load writes no trace, so the empty row keeps the query hash and links none', () => {
    fs.rmSync(p.hippoRoot, { recursive: true, force: true });
    initStore(p.hippoRoot);
    writeConfig(p);
    const r = run(p, QUERY);
    expect([r.status, r.stdout]).toEqual([0, '']);
    const [e] = eventsN(p, 'ctx-1', 1);
    expect([e.block_state, e.recall_trace_id, e.query_hash]).toEqual(['empty', null, blockHash(QUERY.join(' '))]);
    expect(contextTraces(p)).toEqual([]);
  });

  it('C5: the limit cut names the row it dropped, in the pool that ranked it', () => {
    expect(run(p, [...QUERY, '--limit', '1']).status).toBe(0);
    const [e] = eventsN(p, 'ctx-1', 1);
    const rows = e.candidates.map((c) => [c.outcome, c.pool, c.stage, c.reason]);
    expect(rows[0]).toEqual(['emitted', 'search', 'final', null]);
    expect(rows.slice(1)).toContainEqual(['rejected', 'search', 'limit', 'limit']);
    expect([e.selected_count, e.considered_count]).toEqual([1, e.candidates.length]);
  });

  it('C6: two calls in one session are turns 1 and 2, each linked to its own trace', () => {
    expect(run(p, QUERY).status).toBe(0);
    expect(run(p, ['deploy', 'windows']).status).toBe(0);
    const rows = eventsN(p, 'ctx-1', 2);
    const traces = contextTraces(p);
    expect(rows.map((e) => [e.turn_seq, e.duplicate_of, e.recall_trace_id])).toEqual([[1, null, traces[0].id], [2, null, traces[1].id]]);
  });

  it('C7: no session id leaves an unnumbered missing row', () => {
    expect(run(p, QUERY, null).status).toBe(0);
    const [e] = eventsN(p, null, 1);
    expect([e.event_type, e.session_state, e.turn_seq, e.block_state]).toEqual(['context', 'missing', null, 'sent']);
  });

  it('C8: a zero budget and a holdout session each record disabled and print nothing', () => {
    const zero = run(p, [...QUERY, '--budget', '0'], 'ctx-zero');
    writeConfig(p, { holdout: true });
    const held = run(p, QUERY, 'ctx-held');
    expect([zero.stdout, held.stdout]).toEqual(['', '']);
    expect([eventsN(p, 'ctx-zero', 1)[0].block_state, eventsN(p, 'ctx-held', 1)[0].block_state]).toEqual(['disabled', 'disabled']);
  });

  it('C9: a hook payload with a prompt still leaves a context row with no prompt facts', () => {
    const r = hippo(p, ['context', ...QUERY], { input: promptPayload('ctx-hooked'), env: { HIPPO_FAKE_NOW: FAKE_NOW } });
    expect(r.status, r.stderr).toBe(0);
    const [e] = eventsN(p, 'ctx-hooked', 1);
    expect([e.event_type, e.runtime, e.session_state, e.prompt_hash, e.prompt_length]).toEqual(['context', 'claude-code', 'payload', null, 0]);
  });

  it('C10: the per-prompt hook writes no trace, so its row links none', () => {
    expect(hippo(p, PROMPT_HOOK, { input: promptPayload('ctx-hook') }).status).toBe(0);
    const [e] = eventsN(p, 'ctx-hook', 1);
    expect([e.event_type, e.surface, e.recall_trace_id, e.query_hash]).toEqual(['prompt-submit', 'hook', null, null]);
    expect(contextTraces(p)).toEqual([]);
  });
});

describe('the ledger changes nothing a context call prints', () => {
  let off: Project;

  beforeEach(() => {
    // A byte copy of the seeded store, since a retrieval strengthens what it returns and seeding twice dates rows apart.
    off = project();
    fs.rmSync(off.hippoRoot, { recursive: true, force: true });
    fs.cpSync(p.hippoRoot, off.hippoRoot, { recursive: true });
    writeConfig(off, { ledger: false });
  });

  afterEach(() => {
    dispose(off);
  });

  it.each([
    ['markdown', [...QUERY]],
    ['json', [...QUERY, '--format', 'json']],
    ['no query', []],
  ])('C11: %s output is byte-identical with the ledger on and off', (_name, args) => {
    const on = run(p, args);
    const plain = run(off, args);
    expect([on.status, plain.status]).toEqual([0, 0]);
    expect(on.stdout).not.toBe('');
    expect(on.stdout).toBe(plain.stdout);
    expect([eventCount(p), eventCount(off)]).toEqual([1, 0]);
  });

  const resultRows = (target: Project) => tableRows(target, `SELECT t.id AS trace_id, r.memory_id, r.result_rank, r.score
    FROM recall_trace_results r JOIN recall_traces t ON t.id = r.trace_id WHERE t.pipeline = 'context' ORDER BY t.id, r.result_rank`);
  const retrievalCounts = (target: Project) => tableRows(target, 'SELECT id, retrieval_count FROM memories ORDER BY id');

  it('I1: a query in both formats prints the same bytes and leaves the same trace results and retrieval counts', () => {
    for (const args of [[...QUERY], [...QUERY, '--format', 'json']]) {
      const on = run(p, args);
      const plain = run(off, args);
      expect([on.status, plain.status], on.stderr + plain.stderr).toEqual([0, 0]);
      expect(on.stdout).not.toBe('');
      expect(on.stdout).toBe(plain.stdout);
    }
    const rows = resultRows(off);
    expect(rows.length).toBeGreaterThan(0);
    expect(resultRows(p)).toEqual(rows);
    expect(retrievalCounts(p)).toEqual(retrievalCounts(off));
    expect([eventCount(p), eventCount(off)]).toEqual([2, 0]);
  });

  it('I2: a query that matches nothing prints the same empty output and writes the same empty trace', () => {
    const args = ['zzqxv', 'wplmk'];
    const on = run(p, args);
    const plain = run(off, args);
    expect([on.status, plain.status]).toEqual([0, 0]);
    expect([on.stdout, plain.stdout]).toEqual(['', '']);
    const traces = (target: Project) => tableRows(target, `SELECT query_hash, result_count FROM recall_traces WHERE pipeline = 'context'`);
    expect(traces(off)).toHaveLength(1);
    expect(traces(p)).toEqual(traces(off));
    expect(retrievalCounts(p)).toEqual(retrievalCounts(off));
  });
});
