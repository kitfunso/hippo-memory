// The reader's tool-failure listing, lesson link and origin field, on rows the built `hippo capture-error` wrote.
import { describe, it, expect } from 'vitest';
import type { DeliveryEventInput } from '../../src/base/session/delivery.js';
import { writeDeliveryEventOnHandle } from '../../src/store/sqlite/recall-trace.js';
import { blockHash } from '../../src/base/util/token-text.js';
import { realpathOrResolve } from '../../src/base/util/real-path.js';
import { hippoIn, withDb, type Project } from '../_helpers/delivery-boundary.js';
import { configure, expectVerdict, fireIn } from '../_helpers/host-transcript.js';
import {
  V,
  P1,
  P2,
  ERR_ALPHA,
  ERR_BETA,
  RECALL_PROMPT,
  ROUTINE,
  callKey,
  num,
  fail,
  failWhere,
  toolFailureScratch,
} from '../_helpers/tool-failure-ledger.js';

let p: Project;

const { mk, rows, events, logs, lessons, lessonWith, list, read, doc } = toolFailureScratch(() => p);

describe('tool-failure listing, lesson and origin', () => {
  it('TF1 a stored failure is listed after prompt 1, and its lesson reaches prompt 2 with the failure as origin', async () => {
    p = mk();
    configure(p, { promptRecall: true });
    const r1 = await fireIn(p, 'tf1', P1);
    await fail(p, 'tf1', { tool_use_id: 'toolu_tf1' }, { spawned: true });
    const r2 = await fireIn(p, 'tf1', RECALL_PROMPT);
    const ev = events('tf1');
    const log = logs();
    expect(
      ev.map((e) => [
        e.event_type,
        e.turn_seq,
        e.duplicate_of,
        e.tool_use_id,
        e.failure_id,
        e.ledger_version,
        e.runtime,
      ]),
    ).toEqual([
      ['prompt-submit', 1, null, null, null, V, 'claude-code'],
      ['tool-failure', 1, null, 'toolu_tf1', log[0].id, V, 'claude-code'],
      ['prompt-submit', 2, null, null, null, V, 'claude-code'],
    ]);
    expect(log.map((l) => [l.outcome, l.tool])).toEqual([['stored', 'Bash']]);
    const [lesson] = lessons();
    expect(lessons()).toHaveLength(1);
    const id = String(lesson.id);
    expect(
      rows('SELECT pool, outcome, stage FROM delivery_candidates WHERE event_id = ? AND memory_id = ?', p.hippoRoot, [
        num(ev[2].id),
        id,
      ]),
    ).toEqual([{ pool: 'prompt-recall', outcome: 'emitted', stage: 'final' }]);
    const listing = list('tf1');
    expect(listing.entries).toEqual([
      {
        event_id: ev[1].id,
        turn_seq: 1,
        after_prompt_turn: 1,
        tool_use_id: 'toolu_tf1',
        failure_id: log[0].id,
        outcome: 'stored',
        tool: 'Bash',
        duplicates: 0,
        lesson: id,
      },
    ]);
    expect(listing.notes).toEqual([]);
    const v = read('tf1', id, {
      transcript: doc('tf1', [
        { prompt: P1, stdout: r1.stdout },
        { prompt: RECALL_PROMPT, stdout: r2.stdout },
      ]),
    });
    expectVerdict(v, {
      store: p.hippoRoot,
      session: 'tf1',
      memory: id,
      class: 'application-unknown',
      reason: null,
      turn: { event_id: num(ev[2].id), turn_seq: 2 },
      stage: 'final',
    });
    expect([v.turns.at(-1)?.delivery, v.turns.at(-1)?.pool, v.turns.at(-1)?.outcome]).toEqual([
      'confirmed',
      'prompt-recall',
      'emitted',
    ]);
    expect(v.turns.map((t) => t.event_id)).toEqual([ev[0].id, ev[2].id]);
    expect(v.origin).toBe(ev[1].id);
    expect(v.notes).toContain(`tool-failure:${ev[1].id}`);
  });

  it('TF2 a routine failure is listed as skipped-routine with no lesson and no memory', async () => {
    p = mk();
    await fail(p, 'tf2', ROUTINE);
    const [row] = events('tf2');
    expect([callKey(row), row.failure_id, row.ledger_version]).toEqual([
      ['tool-failure', 1, null, 'toolu_1'],
      logs()[0].id,
      V,
    ]);
    expect(lessons()).toEqual([]);
    expect(list('tf2').entries).toEqual([
      {
        event_id: row.id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_1',
        failure_id: row.failure_id,
        outcome: 'skipped-routine',
        tool: 'Bash',
        duplicates: 0,
        lesson: null,
      },
    ]);
  });

  it('TF3 duplicated fires of two tool calls give two entries; a repeated error text is a duplicate with no lesson', async () => {
    p = mk();
    for (const id of ['toolu_a', 'toolu_a', 'toolu_b', 'toolu_b']) await fail(p, 'tf3', { tool_use_id: id });
    const ev = events('tf3');
    const log = logs();
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_a'],
      ['tool-failure', null, ev[0].id, 'toolu_a'],
      ['tool-failure', 2, null, 'toolu_b'],
      ['tool-failure', null, ev[2].id, 'toolu_b'],
    ]);
    expect(ev.map((e) => e.failure_id)).toEqual(log.map((l) => l.id));
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'duplicate', 'duplicate', 'duplicate']);
    expect(log[2].sig_hash).toBe(log[0].sig_hash);
    const lesson = String(lessons()[0].id);
    expect(lessons()).toHaveLength(1);
    const listing = list('tf3');
    expect(
      listing.entries.map((e) => [
        e.event_id,
        e.turn_seq,
        e.tool_use_id,
        e.failure_id,
        e.outcome,
        e.duplicates,
        e.lesson,
      ]),
    ).toEqual([
      [ev[0].id, 1, 'toolu_a', log[0].id, 'stored', 1, lesson],
      [ev[2].id, 2, 'toolu_b', log[2].id, 'duplicate', 1, null],
    ]);
    const v = read('tf3', lesson);
    expect(v.origin).toBe(ev[0].id);
    expect(v.turns).toEqual([]);
    expect(v.notes).toEqual(
      expect.arrayContaining([
        `tool-failure:${ev[0].id}`,
        `tool-failure-duplicate:${ev[1].id}`,
        `tool-failure:${ev[2].id}`,
        `tool-failure-duplicate:${ev[3].id}`,
      ]),
    );
  });

  it('TF4 two lesson-worthy failures with distinct ids link to their own memories', async () => {
    p = mk();
    await fail(p, 'tf4', { tool_use_id: 'toolu_alpha', error: ERR_ALPHA });
    await fail(p, 'tf4', { tool_use_id: 'toolu_beta', error: ERR_BETA });
    const ev = events('tf4');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_alpha'],
      ['tool-failure', 2, null, 'toolu_beta'],
    ]);
    const { entries } = list('tf4');
    expect(entries.map((e) => [e.event_id, e.outcome, e.lesson])).toEqual([
      [ev[0].id, 'stored', lessonWith('alpha')],
      [ev[1].id, 'stored', lessonWith('beta')],
    ]);
    expect(new Set(entries.map((e) => e.lesson)).size).toBe(2);
  });

  it('TF5 with no tool_use_id two fires give two numbered rows', async () => {
    p = mk();
    await fail(p, 'tf5', { tool_use_id: undefined });
    await fail(p, 'tf5', { tool_use_id: undefined });
    const ev = events('tf5');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, null],
      ['tool-failure', 2, null, null],
    ]);
    const { entries } = list('tf5');
    expect(entries.map((e) => [e.event_id, e.tool_use_id, e.outcome, e.duplicates])).toEqual([
      [ev[0].id, null, 'stored', 0],
      [ev[1].id, null, 'duplicate', 0],
    ]);
  });

  it('TF6 a sub-agent failure is an unnumbered row, not listed, and noted on a class read', async () => {
    p = mk();
    await fireIn(p, 'tf6', P1);
    await fail(p, 'tf6', { agent_id: 'agent-1', tool_use_id: 'toolu_sub' });
    const ev = events('tf6');
    expect(ev.map((e) => [e.event_type, e.session_state, e.turn_seq, e.duplicate_of])).toEqual([
      ['prompt-submit', 'payload', 1, null],
      ['tool-failure', 'subagent', null, null],
    ]);
    expect(list('tf6')).toEqual({ entries: [], notes: [] });
    const lesson = String(lessons()[0].id);
    const v = read('tf6', lesson);
    expect(v.notes).toEqual(expect.arrayContaining([`subagent:${ev[1].id}`, `subagent-outcome:${ev[1].id}:none`]));
    expect(v.notes.some((n) => n.startsWith('tool-failure'))).toBe(false);
    expect([v.origin, v.turns.length]).toEqual([null, 1]);
  });

  it('TF7 prompt, failure, prompt, failure: after_prompt_turn is 1 then 2', async () => {
    p = mk();
    await fireIn(p, 'tf7', P1);
    await fail(p, 'tf7', { tool_use_id: 'toolu_7a', error: ERR_ALPHA });
    await fireIn(p, 'tf7', P2);
    await fail(p, 'tf7', { tool_use_id: 'toolu_7b', error: ERR_BETA });
    const ev = events('tf7');
    expect(ev.map((e) => [e.event_type, e.turn_seq])).toEqual([
      ['prompt-submit', 1],
      ['tool-failure', 1],
      ['prompt-submit', 2],
      ['tool-failure', 2],
    ]);
    expect(list('tf7').entries.map((e) => [e.event_id, e.turn_seq, e.after_prompt_turn])).toEqual([
      [ev[1].id, 1, 1],
      [ev[3].id, 2, 2],
    ]);
  });

  it('TF8 a Copilot failure carries runtime copilot and no tool_use_id, so two fires stay two rows', async () => {
    p = mk();
    const copilot = JSON.stringify({
      sessionId: 'tf8',
      toolName: 'bash',
      toolArgs: JSON.stringify({ command: 'make all' }),
      error: ERR_ALPHA,
    });
    for (let i = 0; i < 2; i++) {
      const r = await hippoIn(p, ['capture-error', '--runtime', 'copilot'], { input: copilot });
      expect([r.status, r.stdout]).toEqual([0, '']);
    }
    const ev = events('tf8');
    expect(
      ev.map((e) => [
        e.event_type,
        e.runtime,
        e.session_state,
        e.turn_seq,
        e.duplicate_of,
        e.tool_use_id,
        e.ledger_version,
      ]),
    ).toEqual([
      ['tool-failure', 'copilot', 'payload', 1, null, null, V],
      ['tool-failure', 'copilot', 'payload', 2, null, null, V],
    ]);
    expect(list('tf8').entries.map((e) => [e.event_id, e.tool_use_id, e.tool, e.outcome])).toEqual([
      [ev[0].id, null, 'bash', 'stored'],
      [ev[1].id, null, 'bash', 'duplicate'],
    ]);
  });
});

describe('lesson links and the ledger loss window', () => {
  it('TF11 a forgotten lesson is not replaced by a later failure with the same signature', async () => {
    p = mk();
    await fail(p, 'tf11', { tool_use_id: 'toolu_first' });
    const first = String(lessons()[0].id);
    const gone = await hippoIn(p, ['forget', first]);
    expect(gone.status, gone.stderr).toBe(0);
    expect(lessons()).toEqual([]);
    await fail(p, 'tf11', { tool_use_id: 'toolu_second' });
    const ev = events('tf11');
    const log = logs();
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'stored']);
    const second = String(lessons()[0].id);
    expect(second).not.toBe(first);
    const note = `lesson-superseded:${ev[0].id}:${log[1].id}`;
    const listing = list('tf11');
    expect(listing.entries.map((e) => [e.event_id, e.lesson])).toEqual([
      [ev[0].id, null],
      [ev[1].id, second],
    ]);
    expect(listing.notes).toEqual([note]);
    const v = read('tf11', second);
    expect(v.origin).toBe(ev[1].id);
    expect(v.notes).toContain(note);
  });

  it('TF12 when the failure_log write throws the hook still writes one row with no failure_id, listed as log-missing', async () => {
    p = mk();
    failWhere(p, 'tf12', 'INSERT INTO failure_log', { tool_use_id: 'toolu_loss' });
    const ev = events('tf12');
    expect(ev.map((e) => [e.event_type, e.tool_use_id, e.failure_id])).toEqual([['tool-failure', 'toolu_loss', null]]);
    expect(list('tf12').entries.map((e) => [e.event_id, e.outcome, e.lesson])).toEqual([
      [ev[0].id, 'log-missing', null],
    ]);
  });

  it('TF13 a stored log row whose ledger row flushed second still names the entry, its lesson and its origin', async () => {
    p = mk();
    failWhere(p, 'tf13', 'INSERT INTO delivery_events', { tool_use_id: 'toolu_race' });
    expect(events('tf13')).toEqual([]);
    await fail(p, 'tf13', { tool_use_id: 'toolu_race' });
    const log = logs();
    expect(log.map((l) => l.outcome)).toEqual(['stored', 'duplicate']);
    const numbered = events('tf13');
    expect(numbered.map(callKey)).toEqual([['tool-failure', 1, null, 'toolu_race']]);
    const input: DeliveryEventInput = {
      ts: new Date().toISOString(),
      tenantId: 'default',
      runtime: 'claude-code',
      eventType: 'tool-failure',
      surface: 'hook',
      storeHash: blockHash(realpathOrResolve(p.hippoRoot)),
      writeStore: 'local',
      projectHash: null,
      sessionId: 'tf13',
      sessionState: 'payload',
      hostTurnId: null,
      promptHash: null,
      promptLength: 0,
      queryHash: null,
      recallTraceId: null,
      blockState: 'empty',
      promptRecall: false,
      consideredCount: 0,
      filteredCount: 0,
      selectedCount: 0,
      emittedCount: 0,
      rejectedCount: 0,
      rejectedUnlisted: 0,
      sectionsShown: 0,
      sectionsDropped: 0,
      budgetTokens: 0,
      selectedTokens: 0,
      injectedTokens: 0,
      staticHash: null,
      recallHash: null,
      emittedHash: null,
      elapsedMs: 1,
      toolUseId: 'toolu_race',
      failureId: num(log[0].id),
      candidates: [],
    };
    expect(withDb(p, (db) => writeDeliveryEventOnHandle(db, input))).not.toBeNull();
    const ev = events('tf13');
    expect(ev.map(callKey)).toEqual([
      ['tool-failure', 1, null, 'toolu_race'],
      ['tool-failure', null, ev[0].id, 'toolu_race'],
    ]);
    const lesson = String(lessons()[0].id);
    expect(list('tf13').entries).toEqual([
      {
        event_id: ev[0].id,
        turn_seq: 1,
        after_prompt_turn: null,
        tool_use_id: 'toolu_race',
        failure_id: log[0].id,
        outcome: 'stored',
        tool: 'Bash',
        duplicates: 1,
        lesson,
      },
    ]);
    expect(read('tf13', lesson).origin).toBe(ev[0].id);
  });
});
