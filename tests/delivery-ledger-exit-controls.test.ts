// Z10 exit negative controls: constructions where a join must NOT confirm, so a reader that over-joins fails here.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PROMPT_HOOK, dispose, hippo, project, tableRows, writeConfig, type Project } from './_helpers/delivery-boundary.js';
import { additionalContextOf, fire, seed, verdictOf, writeHostTranscript, type ReadOpts, type TurnSpec } from './_helpers/host-transcript.js';

const PROMPT = 'how should the postgres migration rollback plan work';
const P1 = 'first question about deploys';
const P2 = 'second question about the test suite';
const P3 = 'third question about the release';
const BIG = `PINNED: ${'the deploy checklist covers every service and region '.repeat(30)}`;
const TIGHT = [...PROMPT_HOOK, '--budget', '200'];

let p: Project;
afterEach(() => {
  if (p) dispose(p);
});

const rows = (sql: string, at: Project = p) => tableRows(at, sql);
const pinId = (): string => String(rows('SELECT id FROM memories WHERE pinned = 1')[0].id);
const read = (session: string, memory: string, extra: ReadOpts = {}) =>
  verdictOf({ store: p.hippoRoot, session, memory, ...extra });
const events = (session: string, at: Project = p) => rows(
  `SELECT id, turn_seq, block_state, store_hash, tenant_id, session_state FROM delivery_events WHERE session_id = '${session}' ORDER BY id`, at,
);
const cand = (session: string, memory: string) => rows(
  `SELECT c.outcome, c.reason FROM delivery_candidates c JOIN delivery_events e ON e.id = c.event_id
   WHERE e.session_id = '${session}' AND c.memory_id = '${memory}' ORDER BY c.event_id`,
);
const turnOf = (prompt: string, stdout: string, extra: Partial<TurnSpec> = {}): TurnSpec => ({ prompt, stdout, ...extra });
const doc = (session: string, specs: TurnSpec[]): string => writeHostTranscript(p, specs, { name: session });
const label = (session: string, application: string, signal: string, memory = pinId()) =>
  ({ session_id: session, memory_id: memory, application, signal, evidence: 'the CI run on the release branch' });

describe('negative controls', () => {
  it('N1 a resolved-check label on a rejected memory leaves it rejected and is reported as a conflict', () => {
    p = project();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    fire(p, 'n1', PROMPT, { args: TIGHT });
    expect(cand('n1', big.id)).toEqual([{ outcome: 'rejected', reason: 'budget' }]);
    const v = read('n1', big.id, { labels: [label('n1', 'observed', 'resolved-check', big.id)] });
    expect([v.class, v.notes.includes('label-conflict')]).toEqual(['rejected', true]);
  });

  it('N2 a label for session A read in session B leaves B application-unknown with no label', () => {
    p = project();
    const a = fire(p, 'n2a', P1);
    const b = fire(p, 'n2b', P1);
    expect([events('n2a'), events('n2b')].map((e) => e.length)).toEqual([1, 1]);
    const labels = [label('n2a', 'observed', 'failed-check')];
    expect(read('n2a', pinId(), { transcript: doc('n2a', [turnOf(P1, a.stdout)]), labels }).class).toBe('applied-but-wrong');
    const v = read('n2b', pinId(), { transcript: doc('n2b', [turnOf(P1, b.stdout)]), labels });
    expect([v.class, v.label]).toEqual(['application-unknown', null]);
  });

  it('N3 one changed character in the attachment is delivery-unconfirmed no-attachment', () => {
    p = project();
    const r = fire(p, 'n3', P1);
    const sent = additionalContextOf(r.stdout);
    const changed = `${sent.slice(0, -1)}${sent.endsWith('x') ? 'y' : 'x'}`;
    expect(cand('n3', pinId())).toEqual([{ outcome: 'emitted', reason: null }]);
    const v = read('n3', pinId(), { transcript: doc('n3', [turnOf(P1, r.stdout, { attach: changed })]) });
    expect([v.class, v.reason]).toEqual(['delivery-unconfirmed', 'no-attachment']);
  });

  it('N4 with the ledger off and one fired transcript prompt, a present memory is indeterminate no-event-row', () => {
    p = project();
    writeConfig(p, { ledger: false });
    const r = fire(p, 'n4', P1);
    expect(rows('SELECT COUNT(*) AS c FROM delivery_events')[0].c).toBe(0);
    const v = read('n4', pinId(), { transcript: doc('n4', [turnOf(P1, r.stdout)]) });
    expect([v.class, v.reason]).toEqual(['indeterminate', 'no-event-row']);
  });

  it('N5 a label with an inferred application is ignored and reported', () => {
    p = project();
    const r = fire(p, 'n5', P1);
    const v = read('n5', pinId(), { transcript: doc('n5', [turnOf(P1, r.stdout)]), labels: [label('n5', 'inferred', 'resolved-check')] });
    expect([v.class, v.label, v.notes.includes('label-error:application')]).toEqual(['application-unknown', null, true]);
  });

  it('N6 the hippo attachment under prompt 2 instead of prompt 1 leaves turn 1 unconfirmed', () => {
    p = project();
    const r1 = fire(p, 'n6', P1);
    const r2 = fire(p, 'n6', P2);
    expect(events('n6').map((e) => e.block_state)).toEqual(['sent', 'reused']);
    const t = doc('n6', [turnOf(P1, r1.stdout, { attach: null }), turnOf(P2, r2.stdout, { attach: additionalContextOf(r1.stdout) })]);
    const v = read('n6', pinId(), { transcript: t });
    expect([v.class, v.turns[0].delivery, v.turns[0].why, v.turns[1].delivery]).toEqual(['delivery-unconfirmed', 'unconfirmed', 'no-attachment', 'unconfirmed']);
  });

  it('N7 a store copied after turn 1 reads turn 2 as reused with no original, and notes the foreign row', () => {
    p = project();
    fire(p, 'n7', P1);
    const copyProj = path.join(p.dir, 'copy', 'proj');
    fs.cpSync(p.proj, copyProj, { recursive: true });
    const copy: Project = { ...p, proj: copyProj, cwd: copyProj, hippoRoot: path.join(copyProj, '.hippo') };
    const r2 = hippo(copy, PROMPT_HOOK, { input: JSON.stringify({ session_id: 'n7', prompt: P2, hook_event_name: 'UserPromptSubmit' }) });
    expect([r2.status, r2.stdout]).toEqual([0, '']);
    const evs = events('n7', copy);
    expect(evs.map((e) => [e.turn_seq, e.block_state])).toEqual([[1, 'sent'], [2, 'reused']]);
    expect(evs[0].store_hash).not.toBe(evs[1].store_hash);
    const v = verdictOf({ store: copy.hippoRoot, session: 'n7', memory: pinId() });
    expect([v.class, v.reason, v.turn, v.notes.includes(`foreign-store:${evs[0].id}`)]).toEqual(
      ['delivery-unconfirmed', 'no-original', { event_id: evs[1].id, turn_seq: 2 }, true],
    );
  });

  it('N8 another tenant\'s row under the same session id is never read', () => {
    p = project();
    for (let i = 0; i < 3; i++) seed(p.hippoRoot, `office note ${i}: the coffee machine schedule changes for team lunch on friday`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    const target = seed(p.hippoRoot, 'a lesson from another repo: the staging cluster needs a manual warmup', { origin_project: 'some-other-project', created: '2026-07-01T00:00:00.000Z' });
    fire(p, 'n8', P1);
    fire(p, 'n8', P2, { args: [...PROMPT_HOOK, '--budget', '0'], env: { HIPPO_TENANT: 'other' } });
    const mine = rows(`SELECT id, rejected_unlisted FROM delivery_events WHERE session_id = 'n8' AND tenant_id = 'default'`);
    const theirs = rows(`SELECT id, block_state FROM delivery_events WHERE session_id = 'n8' AND tenant_id = 'other'`);
    expect([mine.length, mine[0].rejected_unlisted, theirs.map((e) => e.block_state)]).toEqual([1, 0, ['disabled']]);
    const v = read('n8', target.id);
    expect([v.class, v.reason, v.turns.map((t) => t.event_id)]).toEqual(['not-retrieved', 'not-loaded', [mine[0].id]]);
  });

  it('N9 a sub-agent row under the parent session is a note and never changes the parent\'s class', () => {
    p = project();
    const big = seed(p.hippoRoot, BIG, { pinned: true });
    hippo(p, PROMPT_HOOK, { input: JSON.stringify({ session_id: 'n9', prompt: 'sub-agent question about the release', hook_event_name: 'UserPromptSubmit', agent_id: 'agent-1' }) });
    fire(p, 'n9', P1, { args: TIGHT });
    const evs = events('n9');
    expect(evs.map((e) => [e.session_state, e.turn_seq])).toEqual([['subagent', null], ['payload', 1]]);
    expect(cand('n9', big.id)).toEqual([{ outcome: 'emitted', reason: null }, { outcome: 'rejected', reason: 'budget' }]);
    const v = read('n9', big.id);
    expect([v.class, v.turns.length, v.turn, v.notes]).toEqual(['rejected', 1, { event_id: evs[1].id, turn_seq: 1 }, [`subagent:${evs[0].id}`, `subagent-outcome:${evs[0].id}:emitted`]]);
  });

  it('N10 command, shell and notification lines with no attachments, plus one real turn, leave no gaps', () => {
    p = project();
    const r = fire(p, 'n10', P1);
    const v = read('n10', pinId(), { transcript: doc('n10', [turnOf(P1, r.stdout)]) });
    expect([v.class, v.notes.filter((n) => n.startsWith('gap:')), v.turns.filter((t) => t.event_id === null)]).toEqual(['application-unknown', [], []]);
  });

  it('N11 a lost row, a compaction and a quiet reused turn with other text is never confirmed', () => {
    p = project();
    const r1 = fire(p, 'n11', P1);
    const r3 = fire(p, 'n11', P3);
    const [e1, e3] = events('n11');
    expect([e1.block_state, e3.block_state, e3.turn_seq]).toEqual(['sent', 'reused', 2]);
    const t = doc('n11', [
      turnOf(P1, r1.stdout),
      turnOf(P2, ''),
      turnOf('a different line the user typed', r3.stdout, { compactBefore: true, fired: false }),
    ]);
    const v = read('n11', pinId(), { transcript: t });
    expect([v.class, v.turn]).toEqual(['application-unknown', { event_id: e1.id, turn_seq: 1 }]);
    expect([v.turns[1].event_id, v.turns[1].paired_by, v.turns[1].delivery, v.turns[1].why]).toEqual([e3.id, null, 'unconfirmed', 'compacted-since-send']);
    expect(v.notes.includes('gap:1')).toBe(true);
    expect(cand('n11', pinId()).map((c) => c.outcome)).toEqual(['emitted', 'reused']);
  });
});
