// Z10 exit fixtures: the built hook writes the ledger rows, and scripts/z10-reconstruct.mjs must name the class each construction implies.
import { describe, it, expect, afterEach } from 'vitest';
import { initStore } from '../src/store/open.js';
import {
  PIN, PROMPT_HOOK, dispose, hippo, hippoNoWorker, preCompactPayload, project, sessionEndPayload, tableRows, type Project,
} from './_helpers/delivery-boundary.js';
import {
  configure, expectVerdict, fire, seed, verdictOf, writeHostTranscript, type Config, type Oracle, type ReadOpts, type TurnSpec, type Verdict,
} from './_helpers/host-transcript.js';

const PROMPT = 'how should the postgres migration rollback plan work';
const P1 = 'first question about deploys';
const P2 = 'second question about the test suite';
const P3 = 'third question about the release';
const BIG = `PINNED: ${'the deploy checklist covers every service and region '.repeat(30)}`;
const TIGHT = [...PROMPT_HOOK, '--budget', '200'];
const NOTE = 'office note: the coffee machine schedule changes for team lunch on friday';
const FAKE_NOW = '2099-01-01T00:00:00.000Z';

let p: Project;
afterEach(() => {
  if (p) dispose(p);
});

const rows = (sql: string) => tableRows(p, sql);
const pinId = (): string => String(rows('SELECT id FROM memories WHERE pinned = 1')[0].id);
const read = (session: string, memory: string, extra: ReadOpts = {}) =>
  verdictOf({ store: p.hippoRoot, session, memory, ...extra });
const events = (session: string) => rows(
  `SELECT id, turn_seq, duplicate_of, block_state, session_state, event_type, prompt_hash, emitted_hash, static_hash, rejected_count, rejected_unlisted, filtered_count
   FROM delivery_events WHERE session_id = '${session}' ORDER BY id`,
);
const cand = (session: string, memory: string) => rows(
  `SELECT c.event_id, c.outcome, c.stage, c.reason, c.pool, c.source_store FROM delivery_candidates c
   JOIN delivery_events e ON e.id = c.event_id WHERE e.session_id = '${session}' AND c.memory_id = '${memory}' ORDER BY c.event_id`,
);
const at = (id: string | number | null, seq: string | number | null) => ({ event_id: Number(id), turn_seq: seq === null ? null : Number(seq) });
const ok = (v: Verdict, session: string, memory: string | null, w: Oracle): void => expectVerdict(v, { store: p.hippoRoot, session, memory, ...w });
const stages = (session: string, memory: string) => cand(session, memory).map((c) => [c.outcome, c.stage]);
const make = (cfg?: Config): void => {
  p = project();
  if (cfg) configure(p, cfg);
};
const turnOf = (prompt: string, stdout: string, extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt, stdout, ...extra });
const doc = (session: string, specs: TurnSpec[]): string => writeHostTranscript(p, specs, { name: session });

/** One sent turn on the default project: the pin is emitted and its attachment is under the prompt. */
function sentTurn(session: string, spec: Partial<TurnSpec> = {}): string {
  const r = fire(p, session, P1);
  return doc(session, [turnOf(P1, r.stdout, spec)]);
}

describe('capture: a lesson the store never held at the turn', () => {
  it('X1 a key for text never written, in a session that has rows, is not-written no-row', () => {
    make();
    fire(p, 'x1', P1);
    expect(events('x1')).toHaveLength(1);
    const v = verdictOf({ store: p.hippoRoot, session: 'x1', key: 'a sentence nobody wrote', global: false });
    ok(v, 'x1', null, { class: 'not-written', reason: 'no-row', turn: null, stage: null });
  });

  it('X1b a memory written after the session\'s only turn is not-written written-after', () => {
    make();
    fire(p, 'x1b', P1);
    const late = seed(p.hippoRoot, 'a lesson written after the turn: always tag the release branch');
    const [e] = events('x1b');
    expect(cand('x1b', late.id)).toEqual([]);
    expect(String(rows(`SELECT created FROM memories WHERE id = '${late.id}'`)[0].created) > String(rows(`SELECT ts FROM delivery_events WHERE id = ${e.id}`)[0].ts)).toBe(true);
    const v = read('x1b', late.id);
    ok(v, 'x1b', late.id, { class: 'not-written', reason: 'written-after', turn: at(e.id, 1), stage: null });
  });

  it('X1c a memory forgotten before the first turn, read by id, is not-written forgotten-before', () => {
    make();
    const gone = seed(p.hippoRoot, 'a lesson that is forgotten before any prompt: always rotate the keys');
    expect(hippo(p, ['forget', gone.id]).status).toBe(0);
    fire(p, 'x1c', P1);
    expect(rows(`SELECT id FROM memories WHERE id = '${gone.id}'`)).toEqual([]);
    const audit = rows(`SELECT ts FROM audit_log WHERE op = 'forget' AND target_id = '${gone.id}'`);
    expect(audit).toHaveLength(1);
    expect(String(audit[0].ts) < String(rows('SELECT ts FROM delivery_events')[0].ts)).toBe(true);
    const v = read('x1c', gone.id);
    ok(v, 'x1c', gone.id, { class: 'not-written', reason: 'forgotten-before', turn: null, stage: null });
  });
});

describe('budgeted evidence: why a lesson never reached the model', () => {
  it('X2 a memory the loader refuses (another project) is not-retrieved not-loaded', () => {
    make();
    for (let i = 0; i < 3; i++) seed(p.hippoRoot, `${NOTE} ${i}`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    const target = seed(p.hippoRoot, 'a lesson from another repo: the staging cluster needs a manual warmup', { origin_project: 'some-other-project', created: '2026-07-01T00:00:00.000Z' });
    fire(p, 'x2', P1);
    const [e] = events('x2');
    expect([cand('x2', target.id), e.rejected_unlisted, Number(e.filtered_count) >= 1]).toEqual([[], 0, true]);
    const v = read('x2', target.id);
    ok(v, 'x2', target.id, { class: 'not-retrieved', reason: 'not-loaded', turn: at(e.id, 1), stage: null });
  });

  it('X2b with prompt recall off and a window past five rows, the oldest memory is indeterminate undecided', () => {
    make();
    const target = seed(p.hippoRoot, `${NOTE} oldest`, { created: '2026-05-01T00:00:00.000Z' });
    for (let i = 0; i < 6; i++) seed(p.hippoRoot, `${NOTE} ${i}`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    fire(p, 'x2b', P1);
    const [e] = events('x2b');
    expect(cand('x2b', target.id)).toEqual([]);
    expect(Number(e.rejected_unlisted)).toBeGreaterThan(0);
    expect(Number(e.rejected_count) - Number(e.rejected_unlisted)).toBeLessThan(16);
    const v = read('x2b', target.id);
    ok(v, 'x2b', target.id, { class: 'indeterminate', reason: 'undecided', turn: at(e.id, 1), stage: null });
  });

  it('X3 a weak prompt-recall match under the gate is rejected at gate gate-below-threshold', () => {
    make({ promptRecall: true, promptRecallMinShared: 2 });
    seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    const weak = seed(p.hippoRoot, 'postgres note 0: the reporting cluster pools its connections through pgbouncer');
    fire(p, 'x3', PROMPT);
    const [e] = events('x3');
    expect(cand('x3', weak.id).map((c) => [c.outcome, c.stage, c.reason])).toEqual([['rejected', 'gate', 'gate-below-threshold']]);
    const v = read('x3', weak.id);
    ok(v, 'x3', weak.id, { class: 'rejected', reason: 'gate-below-threshold', turn: at(e.id, 1), stage: 'gate' });
    expect(v.cand_reason).toBe('gate-below-threshold');
  });

  it('X4 an oversized pin under --budget 200 is rejected at budget', () => {
    make();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    fire(p, 'x4', PROMPT, { args: TIGHT });
    const [e] = events('x4');
    expect(cand('x4', big.id).map((c) => [c.outcome, c.stage, c.reason])).toEqual([['rejected', 'budget', 'budget']]);
    const v = read('x4', big.id);
    ok(v, 'x4', big.id, { class: 'rejected', reason: 'budget', turn: at(e.id, 1), stage: 'budget' });
    expect(v.cand_reason).toBe('budget');
  });

  it('X5 with 16 listed rejections, an unlisted note is indeterminate unlisted and a listed one is rejected', () => {
    make({ promptRecall: true, promptRecallMinShared: 2 });
    seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    const notes = Array.from({ length: 20 }, (_, i) => seed(p.hippoRoot, `postgres note ${i}: the reporting cluster pools its connections through pgbouncer`));
    fire(p, 'x5', PROMPT);
    const [e] = events('x5');
    expect(Number(e.rejected_count) - Number(e.rejected_unlisted)).toBe(16);
    const listed = notes.filter((n) => cand('x5', n.id).length === 1);
    const unlisted = notes.filter((n) => cand('x5', n.id).length === 0);
    expect([listed.length, unlisted.length >= 4]).toEqual([16, true]);
    const u = read('x5', unlisted[0].id);
    ok(u, 'x5', unlisted[0].id, { class: 'indeterminate', reason: 'unlisted', turn: at(e.id, 1), stage: null });
    expect(stages('x5', listed[0].id)).toEqual([['rejected', 'gate']]);
    const l = read('x5', listed[0].id);
    ok(l, 'x5', listed[0].id, { class: 'rejected', reason: 'gate-below-threshold', turn: at(e.id, 1), stage: 'gate' });
    expect(l.cand_reason).toBe('gate-below-threshold');
  });

  it('X5b with promptRecallMaxItems 1, the second strong match is rejected at gate gate-max-items', () => {
    make({ promptRecall: true, promptRecallMaxItems: 1 });
    seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    seed(p.hippoRoot, 'postgres migration rollback plan review checklist for every deploy');
    fire(p, 'x5b', PROMPT);
    const cut = rows(`SELECT memory_id FROM delivery_candidates WHERE reason = 'gate-max-items'`);
    expect(cut).toHaveLength(1);
    const [e] = events('x5b');
    const mem = String(cut[0].memory_id);
    expect(stages('x5b', mem)).toEqual([['rejected', 'gate']]);
    const v = read('x5b', mem);
    ok(v, 'x5b', mem, { class: 'rejected', reason: 'gate-max-items', turn: at(e.id, 1), stage: 'gate' });
    expect(v.cand_reason).toBe('gate-max-items');
  });

  it('X5c an unpinned twin of a pin, inside the loaded window, is rejected at load as a duplicate', () => {
    make();
    const twin = seed(p.hippoRoot, PIN);
    fire(p, 'x5c', P1);
    const [e] = events('x5c');
    expect(cand('x5c', twin.id).map((c) => [c.outcome, c.stage, c.reason, c.pool])).toEqual([['rejected', 'load', 'duplicate', 'recent']]);
    const v = read('x5c', twin.id);
    ok(v, 'x5c', twin.id, { class: 'rejected', reason: 'duplicate', turn: at(e.id, 1), stage: 'load' });
    expect([v.cand_reason, v.turns[0].pool]).toEqual(['duplicate', 'recent']);
  });

  it('X15b a context call with --limit 1 records the cut match as rejected at limit', () => {
    make();
    const a = seed(p.hippoRoot, 'the rollback runbook for postgres migrations lives in the ops wiki');
    const b = seed(p.hippoRoot, 'the postgres migration rollback checklist needs two reviewers');
    expect(hippo(p, ['context', 'postgres', '--limit', '1'], { env: { HIPPO_SESSION_ID: 'x15b' } }).status).toBe(0);
    const cut = rows(`SELECT c.memory_id FROM delivery_candidates c WHERE c.reason = 'limit'`);
    const [e] = events('x15b');
    expect([cut.length, e.event_type]).toEqual([1, 'context']);
    expect([a.id, b.id]).toContain(cut[0].memory_id);
    expect(stages('x15b', String(cut[0].memory_id))).toEqual([['rejected', 'limit']]);
    const v = read('x15b', String(cut[0].memory_id));
    ok(v, 'x15b', String(cut[0].memory_id), { class: 'rejected', reason: 'limit', turn: at(e.id, e.turn_seq), stage: 'limit' });
    expect(v.cand_reason).toBe('limit');
  });

  it('X16 a holdout session records a disabled block, so the pin is rejected block-disabled', () => {
    make({ holdout: true });
    fire(p, 'x16', P1);
    const [e] = events('x16');
    expect([e.block_state, rows('SELECT COUNT(*) AS c FROM delivery_candidates')[0].c]).toEqual(['disabled', 0]);
    const v = read('x16', pinId());
    ok(v, 'x16', pinId(), { class: 'rejected', reason: 'block-disabled', turn: at(e.id, 1), stage: null });
  });
});

describe('context availability: was the block that carried the lesson delivered', () => {
  it('X6 a pin emitted with its attachment withheld is delivery-unconfirmed no-attachment', () => {
    make();
    const t = sentTurn('x6', { attach: null });
    const [e] = events('x6');
    expect([e.block_state, stages('x6', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x6', pinId(), { transcript: t });
    ok(v, 'x6', pinId(), { class: 'delivery-unconfirmed', reason: 'no-attachment', turn: at(e.id, 1), stage: 'final' });
    expect(v.turns[0].paired_by).toBe('prompt');
  });

  it('X6b the same without a transcript is delivery-unconfirmed no-transcript', () => {
    make();
    fire(p, 'x6b', P1);
    const [e] = events('x6b');
    expect([e.block_state, stages('x6b', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x6b', pinId());
    ok(v, 'x6b', pinId(), { class: 'delivery-unconfirmed', reason: 'no-transcript', turn: at(e.id, 1), stage: 'final' });
  });

  it('X7 a pin emitted with its attachment present is application-unknown at turn 1', () => {
    make();
    const t = sentTurn('x7');
    const [e] = events('x7');
    expect([e.block_state, stages('x7', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x7', pinId(), { transcript: t });
    ok(v, 'x7', pinId(), { class: 'application-unknown', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect([v.turns[0].delivery, v.label]).toEqual(['confirmed', null]);
    expect(v.store_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('X10 an unchanged block on turn 2 is reused and takes turn 1\'s confirmed delivery', () => {
    make();
    const r1 = fire(p, 'x10', P1);
    const r2 = fire(p, 'x10', P2);
    const [e1, e2] = events('x10');
    expect([e1.block_state, e2.block_state, r2.stdout]).toEqual(['sent', 'reused', '']);
    expect(stages('x10', pinId())).toEqual([['emitted', 'final'], ['reused', 'final']]);
    const v = read('x10', pinId(), { transcript: doc('x10', [turnOf(P1, r1.stdout), turnOf(P2, r2.stdout)]) });
    ok(v, 'x10', pinId(), { class: 'application-unknown', reason: null, turn: at(e1.id, 1), stage: 'final' });
    expect([v.turns[1].delivery, v.turns[1].via_event_id, v.turns[1].event_id]).toEqual(['confirmed', e1.id, e2.id]);
  });

  it('X11 reuse across a compaction the transcript shows but hippo missed is unconfirmed compacted-since-send', () => {
    make();
    const r1 = fire(p, 'x11', P1);
    const r2 = fire(p, 'x11', P2);
    expect(rows(`SELECT event_type FROM delivery_events WHERE session_id = 'x11' AND event_type <> 'prompt-submit'`)).toEqual([]);
    const [e1, e2] = events('x11');
    expect([e1.block_state, e2.block_state, stages('x11', pinId())]).toEqual(['sent', 'reused', [['emitted', 'final'], ['reused', 'final']]]);
    const v = read('x11', pinId(), { transcript: doc('x11', [turnOf(P1, r1.stdout), turnOf(P2, r2.stdout, { compactBefore: true })]) });
    ok(v, 'x11', pinId(), { class: 'application-unknown', reason: null, turn: at(e1.id, 1), stage: 'final' });
    expect([v.turns[1].delivery, v.turns[1].why]).toEqual(['unconfirmed', 'compacted-since-send']);
  });

  it('X11b a compaction hippo saw resets the block, so turn 2 is sent and confirmed on its own attachment', () => {
    make();
    const r1 = fire(p, 'x11b', P1);
    expect(hippo(p, ['pre-compact'], { input: preCompactPayload('x11b') }).status).toBe(0);
    const r2 = fire(p, 'x11b', P2);
    const prompts = events('x11b').filter((e) => e.event_type === 'prompt-submit');
    expect(prompts.map((e) => e.block_state)).toEqual(['sent', 'sent']);
    expect(stages('x11b', pinId())).toEqual([['emitted', 'final'], ['emitted', 'final']]);
    const t = doc('x11b', [turnOf(P1, r1.stdout, { attach: null }), turnOf(P2, r2.stdout, { compactBefore: true })]);
    const v = read('x11b', pinId(), { transcript: t });
    ok(v, 'x11b', pinId(), { class: 'application-unknown', reason: null, turn: at(prompts[1].id, 2), stage: 'final' });
    expect(v.turns[0].why).toBe('no-attachment');
  });

  it('X12 one payload fired twice inside the duplicate window is one turn with the second row as its duplicate', () => {
    make();
    const env = { HIPPO_FAKE_NOW: FAKE_NOW };
    const r1 = fire(p, 'x12', P1, { env });
    fire(p, 'x12', P1, { env });
    const [a, b] = events('x12');
    expect([a.turn_seq, b.turn_seq, b.duplicate_of]).toEqual([1, null, a.id]);
    expect(cand('x12', pinId()).map((c) => [c.event_id, c.outcome, c.stage])).toEqual([[a.id, 'emitted', 'final'], [b.id, 'reused', 'final']]);
    const v = read('x12', pinId(), { transcript: doc('x12', [turnOf(P1, r1.stdout)]) });
    ok(v, 'x12', pinId(), { class: 'application-unknown', reason: null, turn: at(a.id, 1), stage: 'final' });
    expect([v.turns.length, v.turns[0].duplicates]).toEqual([1, [b.id]]);
  });

  it('X13 two interleaved sessions with the same prompt never share event ids', () => {
    make();
    const a1 = fire(p, 'x13a', P1);
    const b1 = fire(p, 'x13b', P1);
    const a2 = fire(p, 'x13a', P2);
    const b2 = fire(p, 'x13b', P2);
    const ids = (s: string) => events(s).map((e) => e.id);
    expect([events('x13a').map((e) => e.block_state), events('x13b').map((e) => e.block_state)]).toEqual([['sent', 'reused'], ['sent', 'reused']]);
    expect(stages('x13a', pinId())).toEqual([['emitted', 'final'], ['reused', 'final']]);
    expect(stages('x13b', pinId())).toEqual([['emitted', 'final'], ['reused', 'final']]);
    expect(new Set([...ids('x13a'), ...ids('x13b')]).size).toBe(4);
    const v = read('x13b', pinId(), { transcript: doc('x13b', [turnOf(P1, b1.stdout), turnOf(P2, b2.stdout)]) });
    ok(v, 'x13b', pinId(), { class: 'application-unknown', reason: null, turn: at(ids('x13b')[0], 1), stage: 'final' });
    expect(v.turns.map((t) => t.event_id)).toEqual(ids('x13b'));
    const va = read('x13a', pinId(), { transcript: doc('x13a', [turnOf(P1, a1.stdout), turnOf(P2, a2.stdout)]) });
    ok(va, 'x13a', pinId(), { class: 'application-unknown', reason: null, turn: at(ids('x13a')[0], 1), stage: 'final' });
    expect(va.turns.map((t) => t.event_id)).toEqual(ids('x13a'));
  });

  it('X14a a prompt the hook never recorded is a gap, so a rejected pin is indeterminate no-event-row', () => {
    make();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    const r1 = fire(p, 'x14a', P1, { args: TIGHT });
    const r3 = fire(p, 'x14a', P3, { args: TIGHT });
    expect(cand('x14a', big.id).map((c) => c.outcome)).toEqual(['rejected', 'rejected']);
    const v = read('x14a', big.id, { transcript: doc('x14a', [turnOf(P1, r1.stdout), turnOf(P2, ''), turnOf(P3, r3.stdout)]) });
    ok(v, 'x14a', big.id, { class: 'indeterminate', reason: 'no-event-row', turn: null, stage: null });
    expect(v.notes.includes('gap:1')).toBe(true);
  });

  it('X14b the same gap does not hide a delivery proven at turn 1', () => {
    make();
    const r1 = fire(p, 'x14b', P1);
    const r3 = fire(p, 'x14b', P3);
    const [e1, e3] = events('x14b');
    expect([e1.block_state, e3.block_state, stages('x14b', pinId())]).toEqual(['sent', 'reused', [['emitted', 'final'], ['reused', 'final']]]);
    const v = read('x14b', pinId(), { transcript: doc('x14b', [turnOf(P1, r1.stdout), turnOf(P2, ''), turnOf(P3, r3.stdout)]) });
    ok(v, 'x14b', pinId(), { class: 'application-unknown', reason: null, turn: at(e1.id, 1), stage: 'final' });
    expect([v.notes.includes('gap:1'), v.turns.filter((t) => t.event_id !== null).map((t) => t.event_id)]).toEqual([true, [e1.id, e3.id]]);
  });

  it('X15 an agent\'s hippo context call returning the lesson is delivery-unconfirmed surface-unjoined', () => {
    make();
    const target = seed(p.hippoRoot, 'the rollback runbook for postgres migrations lives in the ops wiki');
    expect(hippo(p, ['context', 'postgres migrations rollback runbook'], { env: { HIPPO_SESSION_ID: 'x15' } }).status).toBe(0);
    const [e] = events('x15');
    expect([e.event_type, e.session_state, stages('x15', target.id)]).toEqual(['context', 'env', [['emitted', 'final']]]);
    const v = read('x15', target.id);
    ok(v, 'x15', target.id, { class: 'delivery-unconfirmed', reason: 'surface-unjoined', turn: at(e.id, e.turn_seq), stage: 'final' });
    expect(v.turns[0].event_type).toBe('context');
  });

  it('X17 with prompt recall on, a recall block beside a reused static block confirms on turn 2\'s own attachment', () => {
    make({ promptRecall: true });
    const recall = seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    const q1 = 'how should the postgres migration rollback work';
    const q2 = 'does the postgres migration rollback need a review';
    const r1 = fire(p, 'x17', q1);
    const r2 = fire(p, 'x17', q2);
    const [e1, e2] = events('x17');
    expect([e1.block_state, e2.block_state]).toEqual(['sent', 'reused-recall-sent']);
    expect(stages('x17', recall.id)).toEqual([['emitted', 'final'], ['emitted', 'final']]);
    expect(stages('x17', pinId())).toEqual([['emitted', 'final'], ['reused', 'final']]);
    const t = doc('x17', [turnOf(q1, r1.stdout, { attach: null }), turnOf(q2, r2.stdout)]);
    const rv = read('x17', recall.id, { transcript: t });
    ok(rv, 'x17', recall.id, { class: 'application-unknown', reason: null, turn: at(e2.id, 2), stage: 'final' });
    expect([rv.turns[1].delivery, rv.turns[1].via_event_id]).toEqual(['confirmed', null]);
    const pv = read('x17', pinId(), { transcript: doc('x17-b', [turnOf(q1, r1.stdout), turnOf(q2, r2.stdout)]) });
    ok(pv, 'x17', pinId(), { class: 'application-unknown', reason: null, turn: at(e1.id, 1), stage: 'final' });
    expect([pv.turns[1].delivery, pv.turns[1].via_event_id]).toEqual(['confirmed', e1.id]);
  });

  it('X18 a pinned call run by hand is delivery-unconfirmed surface-unjoined', () => {
    make();
    expect(hippo(p, PROMPT_HOOK, { env: { HIPPO_SESSION_ID: 'x18' } }).status).toBe(0);
    const [e] = events('x18');
    expect([e.event_type, e.session_state, stages('x18', pinId())]).toEqual(['pinned-manual', 'env', [['emitted', 'final']]]);
    const v = read('x18', pinId());
    ok(v, 'x18', pinId(), { class: 'delivery-unconfirmed', reason: 'surface-unjoined', turn: at(e.id, e.turn_seq), stage: 'final' });
    expect(v.turns[0].event_type).toBe('pinned-manual');
  });

  it('X19a an image prompt whose text differs from the payload pairs by its attachment and confirms', () => {
    make();
    const r = fire(p, 'x19a', P1);
    const [e] = events('x19a');
    expect([e.block_state, stages('x19a', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const t = doc('x19a', [turnOf('what is in this screenshot', r.stdout, { image: true })]);
    const v = read('x19a', pinId(), { transcript: t });
    ok(v, 'x19a', pinId(), { class: 'application-unknown', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect([v.turns[0].paired_by, v.turns[0].delivery]).toEqual(['attachment', 'confirmed']);
  });

  it('X19b a reused turn whose text differs from the payload pairs by position', () => {
    make();
    const r1 = fire(p, 'x19b', P1);
    const r2 = fire(p, 'x19b', P2);
    const [e1] = events('x19b');
    expect(events('x19b').map((e) => e.block_state)).toEqual(['sent', 'reused']);
    expect(stages('x19b', pinId())).toEqual([['emitted', 'final'], ['reused', 'final']]);
    const t = doc('x19b', [turnOf(P1, r1.stdout), turnOf('what is in this screenshot', r2.stdout, { image: true })]);
    const v = read('x19b', pinId(), { transcript: t });
    ok(v, 'x19b', pinId(), { class: 'application-unknown', reason: null, turn: at(e1.id, 1), stage: 'final' });
    expect([v.turns[1].paired_by, v.turns[1].delivery, v.turns[1].via_event_id]).toEqual(['position', 'confirmed', e1.id]);
  });

  it('X20 a pin that lives only in the global store is application-unknown with source_store global', () => {
    make();
    initStore(p.globalRoot);
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const r = fire(p, 'x20', P1);
    const [e] = events('x20');
    expect(cand('x20', g.id).map((c) => [c.outcome, c.stage, c.source_store])).toEqual([['emitted', 'final', 'global']]);
    const v = read('x20', g.id, { transcript: doc('x20', [turnOf(P1, r.stdout)]), global: p.globalRoot });
    ok(v, 'x20', g.id, { class: 'application-unknown', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect([v.memory_store, v.turns[0].source_store]).toEqual(['global', 'global']);
  });

  it('X22 a queued prompt that was sent confirms on the attachment under its queued line', () => {
    make();
    const r = fire(p, 'x22', P1);
    const [e] = events('x22');
    expect([events('x22').length, e.block_state, stages('x22', pinId())]).toEqual([1, 'sent', [['emitted', 'final']]]);
    const v = read('x22', pinId(), { transcript: doc('x22', [turnOf(P1, r.stdout, { queued: true })]) });
    ok(v, 'x22', pinId(), { class: 'application-unknown', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect([v.turns[0].paired_by, v.turns[0].delivery]).toEqual(['prompt', 'confirmed']);
  });
});

describe('application: labels act only on a confirmed delivery', () => {
  const label = (application: string, signal: string, session: string) =>
    ({ session_id: session, memory_id: pinId(), application, signal, evidence: 'the CI run on the release branch' });

  it('X8 an observed failed-check label on a delivered pin is applied-but-wrong', () => {
    make();
    const t = sentTurn('x8');
    const [e] = events('x8');
    expect([e.block_state, stages('x8', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x8', pinId(), { transcript: t, labels: [label('observed', 'failed-check', 'x8')] });
    ok(v, 'x8', pinId(), { class: 'applied-but-wrong', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect(v.label?.signal).toBe('failed-check');
  });

  it('X9 a judged resolved-check label on a delivered pin is applied-supported', () => {
    make();
    const t = sentTurn('x9');
    const [e] = events('x9');
    expect([e.block_state, stages('x9', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x9', pinId(), { transcript: t, labels: [label('judged', 'resolved-check', 'x9')] });
    ok(v, 'x9', pinId(), { class: 'applied-supported', reason: null, turn: at(e.id, 1), stage: 'final' });
  });

  it('X9b an observed label with an unknown signal is indeterminate outcome-unknown', () => {
    make();
    const t = sentTurn('x9b');
    const [e] = events('x9b');
    expect([e.block_state, stages('x9b', pinId())]).toEqual(['sent', [['emitted', 'final']]]);
    const v = read('x9b', pinId(), { transcript: t, labels: [label('observed', 'unknown', 'x9b')] });
    ok(v, 'x9b', pinId(), { class: 'indeterminate', reason: 'outcome-unknown', turn: at(e.id, 1), stage: 'final' });
  });
});

describe('boundary evidence', () => {
  it('X21 a session-end after the turns is a note, not a turn', () => {
    make();
    const t = sentTurn('x21');
    expect(hippoNoWorker(p, ['session-end'], { input: sessionEndPayload('x21') }).status).toBe(0);
    const end = rows(`SELECT id FROM delivery_events WHERE session_id = 'x21' AND event_type = 'session-end'`);
    expect(end).toHaveLength(1);
    const [e] = events('x21');
    expect([e.event_type, e.block_state, stages('x21', pinId())]).toEqual(['prompt-submit', 'sent', [['emitted', 'final']]]);
    const v = read('x21', pinId(), { transcript: t });
    ok(v, 'x21', pinId(), { class: 'application-unknown', reason: null, turn: at(e.id, 1), stage: 'final' });
    expect([v.notes.includes(`session-end:${end[0].id}`), v.turns.map((x) => x.event_type)]).toEqual([true, ['prompt-submit']]);
  });
});
