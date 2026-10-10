// Z10 exit fixtures: the built hook writes the ledger rows, and scripts/z10-reconstruct.mjs must name the class each construction implies.
import { describe, it, expect, afterEach } from 'vitest';
import { initStore } from '../src/store/open.js';
import {
  PIN, PROMPT_HOOK, dispose, hippo, hippoNoWorker, preCompactPayload, project, sessionEndPayload, tableRows, type Project,
} from './_helpers/delivery-boundary.js';
import { configure, fire, seed, verdictOf, writeHostTranscript, type Config, type ReadOpts, type TurnSpec } from './_helpers/host-transcript.js';

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
    expect([v.class, v.reason, v.memory_id, v.turn]).toEqual(['not-written', 'no-row', null, null]);
  });

  it('X1b a memory written after the session\'s only turn is not-written written-after', () => {
    make();
    fire(p, 'x1b', P1);
    const late = seed(p.hippoRoot, 'a lesson written after the turn: always tag the release branch');
    const [e] = events('x1b');
    expect(cand('x1b', late.id)).toEqual([]);
    expect(String(rows(`SELECT created FROM memories WHERE id = '${late.id}'`)[0].created) > String(rows(`SELECT ts FROM delivery_events WHERE id = ${e.id}`)[0].ts)).toBe(true);
    const v = read('x1b', late.id);
    expect([v.class, v.reason, v.turn, v.memory_id]).toEqual(['not-written', 'written-after', { event_id: e.id, turn_seq: 1 }, late.id]);
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
    expect([v.class, v.reason, v.turn]).toEqual(['not-written', 'forgotten-before', null]);
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
    expect([v.class, v.reason, v.turn]).toEqual(['not-retrieved', 'not-loaded', { event_id: e.id, turn_seq: 1 }]);
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
    expect([v.class, v.reason, v.turn]).toEqual(['indeterminate', 'undecided', { event_id: e.id, turn_seq: 1 }]);
  });

  it('X3 a weak prompt-recall match under the gate is rejected at gate gate-below-threshold', () => {
    make({ promptRecall: true, promptRecallMinShared: 2 });
    seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    const weak = seed(p.hippoRoot, 'postgres note 0: the reporting cluster pools its connections through pgbouncer');
    fire(p, 'x3', PROMPT);
    expect(cand('x3', weak.id).map((c) => [c.outcome, c.stage, c.reason])).toEqual([['rejected', 'gate', 'gate-below-threshold']]);
    const v = read('x3', weak.id);
    expect([v.class, v.stage, v.cand_reason, v.reason]).toEqual(['rejected', 'gate', 'gate-below-threshold', 'gate-below-threshold']);
  });

  it('X4 an oversized pin under --budget 200 is rejected at budget', () => {
    make();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    fire(p, 'x4', PROMPT, { args: TIGHT });
    expect(cand('x4', big.id).map((c) => [c.outcome, c.stage, c.reason])).toEqual([['rejected', 'budget', 'budget']]);
    const v = read('x4', big.id);
    expect([v.class, v.stage, v.cand_reason]).toEqual(['rejected', 'budget', 'budget']);
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
    expect([u.class, u.reason]).toEqual(['indeterminate', 'unlisted']);
    const l = read('x5', listed[0].id);
    expect([l.class, l.stage, l.cand_reason]).toEqual(['rejected', 'gate', 'gate-below-threshold']);
  });

  it('X5b with promptRecallMaxItems 1, the second strong match is rejected at gate gate-max-items', () => {
    make({ promptRecall: true, promptRecallMaxItems: 1 });
    seed(p.hippoRoot, 'the postgres migration script needs a rollback plan before deploy');
    seed(p.hippoRoot, 'postgres migration rollback plan review checklist for every deploy');
    fire(p, 'x5b', PROMPT);
    const cut = rows(`SELECT memory_id FROM delivery_candidates WHERE reason = 'gate-max-items'`);
    expect(cut).toHaveLength(1);
    const v = read('x5b', String(cut[0].memory_id));
    expect([v.class, v.stage, v.cand_reason]).toEqual(['rejected', 'gate', 'gate-max-items']);
  });

  it('X5c an unpinned twin of a pin, inside the loaded window, is rejected at load as a duplicate', () => {
    make();
    const twin = seed(p.hippoRoot, PIN);
    fire(p, 'x5c', P1);
    expect(cand('x5c', twin.id).map((c) => [c.outcome, c.stage, c.reason, c.pool])).toEqual([['rejected', 'load', 'duplicate', 'recent']]);
    const v = read('x5c', twin.id);
    expect([v.class, v.stage, v.cand_reason, v.turns[0].pool]).toEqual(['rejected', 'load', 'duplicate', 'recent']);
  });

  it('X15b a context call with --limit 1 records the cut match as rejected at limit', () => {
    make();
    const a = seed(p.hippoRoot, 'the rollback runbook for postgres migrations lives in the ops wiki');
    const b = seed(p.hippoRoot, 'the postgres migration rollback checklist needs two reviewers');
    expect(hippo(p, ['context', 'postgres', '--limit', '1'], { env: { HIPPO_SESSION_ID: 'x15b' } }).status).toBe(0);
    const cut = rows(`SELECT c.memory_id FROM delivery_candidates c WHERE c.reason = 'limit'`);
    expect([cut.length, events('x15b')[0].event_type]).toEqual([1, 'context']);
    expect([a.id, b.id]).toContain(cut[0].memory_id);
    const v = read('x15b', String(cut[0].memory_id));
    expect([v.class, v.stage, v.cand_reason]).toEqual(['rejected', 'limit', 'limit']);
  });

  it('X16 a holdout session records a disabled block, so the pin is rejected block-disabled', () => {
    make({ holdout: true });
    fire(p, 'x16', P1);
    const [e] = events('x16');
    expect([e.block_state, rows('SELECT COUNT(*) AS c FROM delivery_candidates')[0].c]).toEqual(['disabled', 0]);
    const v = read('x16', pinId());
    expect([v.class, v.reason, v.turn]).toEqual(['rejected', 'block-disabled', { event_id: e.id, turn_seq: 1 }]);
  });
});

describe('context availability: was the block that carried the lesson delivered', () => {
  it('X6 a pin emitted with its attachment withheld is delivery-unconfirmed no-attachment', () => {
    make();
    const t = sentTurn('x6', { attach: null });
    expect(cand('x6', pinId()).map((c) => c.outcome)).toEqual(['emitted']);
    const v = read('x6', pinId(), { transcript: t });
    expect([v.class, v.reason, v.turns[0].paired_by]).toEqual(['delivery-unconfirmed', 'no-attachment', 'prompt']);
  });

  it('X6b the same without a transcript is delivery-unconfirmed no-transcript', () => {
    make();
    fire(p, 'x6b', P1);
    expect(cand('x6b', pinId()).map((c) => c.outcome)).toEqual(['emitted']);
    const v = read('x6b', pinId());
    expect([v.class, v.reason]).toEqual(['delivery-unconfirmed', 'no-transcript']);
  });

  it('X7 a pin emitted with its attachment present is application-unknown at turn 1', () => {
    make();
    const t = sentTurn('x7');
    const [e] = events('x7');
    const v = read('x7', pinId(), { transcript: t });
    expect([v.class, v.turn, v.turns[0].delivery, v.label, v.store_hash, v.tenant_id, v.session_id, v.memory_id])
      .toEqual(['application-unknown', { event_id: e.id, turn_seq: 1 }, 'confirmed', null, v.store_hash, 'default', 'x7', pinId()]);
    expect(v.store_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('X10 an unchanged block on turn 2 is reused and takes turn 1\'s confirmed delivery', () => {
    make();
    const r1 = fire(p, 'x10', P1);
    const r2 = fire(p, 'x10', P2);
    const [e1, e2] = events('x10');
    expect([e1.block_state, e2.block_state, r2.stdout]).toEqual(['sent', 'reused', '']);
    expect(cand('x10', pinId()).map((c) => c.outcome)).toEqual(['emitted', 'reused']);
    const v = read('x10', pinId(), { transcript: doc('x10', [turnOf(P1, r1.stdout), turnOf(P2, r2.stdout)]) });
    expect(v.class).toBe('application-unknown');
    expect([v.turns[1].delivery, v.turns[1].via_event_id, v.turns[1].event_id]).toEqual(['confirmed', e1.id, e2.id]);
  });

  it('X11 reuse across a compaction the transcript shows but hippo missed is unconfirmed compacted-since-send', () => {
    make();
    const r1 = fire(p, 'x11', P1);
    const r2 = fire(p, 'x11', P2);
    expect(rows(`SELECT event_type FROM delivery_events WHERE session_id = 'x11' AND event_type <> 'prompt-submit'`)).toEqual([]);
    const v = read('x11', pinId(), { transcript: doc('x11', [turnOf(P1, r1.stdout), turnOf(P2, r2.stdout, { compactBefore: true })]) });
    const [e1] = events('x11');
    expect([v.class, v.turn, v.turns[1].delivery, v.turns[1].why]).toEqual(['application-unknown', { event_id: e1.id, turn_seq: 1 }, 'unconfirmed', 'compacted-since-send']);
  });

  it('X11b a compaction hippo saw resets the block, so turn 2 is sent and confirmed on its own attachment', () => {
    make();
    const r1 = fire(p, 'x11b', P1);
    expect(hippo(p, ['pre-compact'], { input: preCompactPayload('x11b') }).status).toBe(0);
    const r2 = fire(p, 'x11b', P2);
    const prompts = events('x11b').filter((e) => e.event_type === 'prompt-submit');
    expect(prompts.map((e) => e.block_state)).toEqual(['sent', 'sent']);
    const t = doc('x11b', [turnOf(P1, r1.stdout, { attach: null }), turnOf(P2, r2.stdout, { compactBefore: true })]);
    const v = read('x11b', pinId(), { transcript: t });
    expect([v.class, v.turn, v.turns[0].why]).toEqual(['application-unknown', { event_id: prompts[1].id, turn_seq: 2 }, 'no-attachment']);
  });

  it('X12 one payload fired twice inside the duplicate window is one turn with the second row as its duplicate', () => {
    make();
    const env = { HIPPO_FAKE_NOW: FAKE_NOW };
    const r1 = fire(p, 'x12', P1, { env });
    fire(p, 'x12', P1, { env });
    const [a, b] = events('x12');
    expect([a.turn_seq, b.turn_seq, b.duplicate_of]).toEqual([1, null, a.id]);
    const v = read('x12', pinId(), { transcript: doc('x12', [turnOf(P1, r1.stdout)]) });
    expect([v.class, v.turns.length, v.turns[0].duplicates]).toEqual(['application-unknown', 1, [b.id]]);
  });

  it('X13 two interleaved sessions with the same prompt never share event ids', () => {
    make();
    const a1 = fire(p, 'x13a', P1);
    const b1 = fire(p, 'x13b', P1);
    const a2 = fire(p, 'x13a', P2);
    const b2 = fire(p, 'x13b', P2);
    const ids = (s: string) => events(s).map((e) => e.id);
    const v = read('x13b', pinId(), { transcript: doc('x13b', [turnOf(P1, b1.stdout), turnOf(P2, b2.stdout)]) });
    expect([v.class, v.turns.map((t) => t.event_id)]).toEqual(['application-unknown', ids('x13b')]);
    expect(ids('x13a').some((id) => v.turns.some((t) => t.event_id === id))).toBe(false);
    expect([a1.stdout, a2.stdout].length).toBe(2);
  });

  it('X14a a prompt the hook never recorded is a gap, so a rejected pin is indeterminate no-event-row', () => {
    make();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    const r1 = fire(p, 'x14a', P1, { args: TIGHT });
    const r3 = fire(p, 'x14a', P3, { args: TIGHT });
    expect(cand('x14a', big.id).map((c) => c.outcome)).toEqual(['rejected', 'rejected']);
    const v = read('x14a', big.id, { transcript: doc('x14a', [turnOf(P1, r1.stdout), turnOf(P2, ''), turnOf(P3, r3.stdout)]) });
    expect([v.class, v.reason, v.notes.includes('gap:1')]).toEqual(['indeterminate', 'no-event-row', true]);
  });

  it('X14b the same gap does not hide a delivery proven at turn 1', () => {
    make();
    const r1 = fire(p, 'x14b', P1);
    const r3 = fire(p, 'x14b', P3);
    const [e1, e3] = events('x14b');
    const v = read('x14b', pinId(), { transcript: doc('x14b', [turnOf(P1, r1.stdout), turnOf(P2, ''), turnOf(P3, r3.stdout)]) });
    expect([v.class, v.turn, v.notes.includes('gap:1'), v.turns.filter((t) => t.event_id !== null).map((t) => t.event_id)]).toEqual(
      ['application-unknown', { event_id: e1.id, turn_seq: 1 }, true, [e1.id, e3.id]],
    );
  });

  it('X15 an agent\'s hippo context call returning the lesson is delivery-unconfirmed surface-unjoined', () => {
    make();
    const target = seed(p.hippoRoot, 'the rollback runbook for postgres migrations lives in the ops wiki');
    expect(hippo(p, ['context', 'postgres migrations rollback runbook'], { env: { HIPPO_SESSION_ID: 'x15' } }).status).toBe(0);
    const [e] = events('x15');
    expect([e.event_type, e.session_state, cand('x15', target.id).map((c) => c.outcome)]).toEqual(['context', 'env', ['emitted']]);
    const v = read('x15', target.id);
    expect([v.class, v.reason, v.turns[0].event_type]).toEqual(['delivery-unconfirmed', 'surface-unjoined', 'context']);
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
    expect(cand('x17', recall.id).map((c) => c.outcome)).toEqual(['emitted', 'emitted']);
    const t = doc('x17', [turnOf(q1, r1.stdout, { attach: null }), turnOf(q2, r2.stdout)]);
    const rv = read('x17', recall.id, { transcript: t });
    expect([rv.class, rv.turn, rv.turns[1].delivery, rv.turns[1].via_event_id]).toEqual(['application-unknown', { event_id: e2.id, turn_seq: 2 }, 'confirmed', null]);
    const pv = read('x17', pinId(), { transcript: doc('x17-b', [turnOf(q1, r1.stdout), turnOf(q2, r2.stdout)]) });
    expect([pv.class, pv.turns[1].delivery, pv.turns[1].via_event_id]).toEqual(['application-unknown', 'confirmed', e1.id]);
  });

  it('X18 a pinned call run by hand is delivery-unconfirmed surface-unjoined', () => {
    make();
    expect(hippo(p, PROMPT_HOOK, { env: { HIPPO_SESSION_ID: 'x18' } }).status).toBe(0);
    const [e] = events('x18');
    expect([e.event_type, e.session_state, cand('x18', pinId()).map((c) => c.outcome)]).toEqual(['pinned-manual', 'env', ['emitted']]);
    const v = read('x18', pinId());
    expect([v.class, v.reason, v.turns[0].event_type]).toEqual(['delivery-unconfirmed', 'surface-unjoined', 'pinned-manual']);
  });

  it('X19a an image prompt whose text differs from the payload pairs by its attachment and confirms', () => {
    make();
    const r = fire(p, 'x19a', P1);
    const t = doc('x19a', [turnOf('what is in this screenshot', r.stdout, { image: true })]);
    const v = read('x19a', pinId(), { transcript: t });
    expect([v.class, v.turns[0].paired_by, v.turns[0].delivery]).toEqual(['application-unknown', 'attachment', 'confirmed']);
  });

  it('X19b a reused turn whose text differs from the payload pairs by position', () => {
    make();
    const r1 = fire(p, 'x19b', P1);
    const r2 = fire(p, 'x19b', P2);
    expect(events('x19b').map((e) => e.block_state)).toEqual(['sent', 'reused']);
    const t = doc('x19b', [turnOf(P1, r1.stdout), turnOf('what is in this screenshot', r2.stdout, { image: true })]);
    const v = read('x19b', pinId(), { transcript: t });
    expect([v.turns[1].paired_by, v.turns[1].delivery, v.turns[1].via_event_id]).toEqual(['position', 'confirmed', v.turns[0].event_id]);
  });

  it('X20 a pin that lives only in the global store is application-unknown with source_store global', () => {
    make();
    initStore(p.globalRoot);
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const r = fire(p, 'x20', P1);
    expect(cand('x20', g.id).map((c) => [c.outcome, c.source_store])).toEqual([['emitted', 'global']]);
    const v = read('x20', g.id, { transcript: doc('x20', [turnOf(P1, r.stdout)]), global: p.globalRoot });
    expect([v.class, v.memory_store, v.turns[0].source_store]).toEqual(['application-unknown', 'global', 'global']);
  });
});

describe('application: labels act only on a confirmed delivery', () => {
  const label = (application: string, signal: string, session: string) =>
    ({ session_id: session, memory_id: pinId(), application, signal, evidence: 'the CI run on the release branch' });

  it('X8 an observed failed-check label on a delivered pin is applied-but-wrong', () => {
    make();
    const t = sentTurn('x8');
    expect(cand('x8', pinId()).map((c) => c.outcome)).toEqual(['emitted']);
    const v = read('x8', pinId(), { transcript: t, labels: [label('observed', 'failed-check', 'x8')] });
    expect([v.class, v.label?.signal]).toEqual(['applied-but-wrong', 'failed-check']);
  });

  it('X9 a judged resolved-check label on a delivered pin is applied-supported', () => {
    make();
    const t = sentTurn('x9');
    expect(cand('x9', pinId()).map((c) => c.outcome)).toEqual(['emitted']);
    const v = read('x9', pinId(), { transcript: t, labels: [label('judged', 'resolved-check', 'x9')] });
    expect(v.class).toBe('applied-supported');
  });

  it('X9b an observed label with an unknown signal is indeterminate outcome-unknown', () => {
    make();
    const t = sentTurn('x9b');
    expect(cand('x9b', pinId()).map((c) => c.outcome)).toEqual(['emitted']);
    const v = read('x9b', pinId(), { transcript: t, labels: [label('observed', 'unknown', 'x9b')] });
    expect([v.class, v.reason]).toEqual(['indeterminate', 'outcome-unknown']);
  });
});

describe('boundary evidence', () => {
  it('X21 a session-end after the turns is a note, not a turn', () => {
    make();
    const t = sentTurn('x21');
    expect(hippoNoWorker(p, ['session-end'], { input: sessionEndPayload('x21') }).status).toBe(0);
    const end = rows(`SELECT id FROM delivery_events WHERE session_id = 'x21' AND event_type = 'session-end'`);
    expect(end).toHaveLength(1);
    const v = read('x21', pinId(), { transcript: t });
    expect([v.class, v.notes.includes(`session-end:${end[0].id}`), v.turns.map((x) => x.event_type)]).toEqual(['application-unknown', true, ['prompt-submit']]);
  });
});

