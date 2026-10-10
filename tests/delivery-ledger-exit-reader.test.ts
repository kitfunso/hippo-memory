// The delivery reader on rows the real ledger writer built, plus the transcript parser and the CLI arguments.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { writeDeliveryEventOnHandle } from '../src/store/recall-trace.js';
import type { DeliveryCandidateInput, DeliveryEventInput, DeliveryRejectReason, DeliveryStage } from '../src/store/delivery-recorder.js';
import { blockHash } from '../src/util/token-text.js';
import { realpathOrResolve } from '../src/util/real-path.js';
import type { JsonValue } from '../src/util/json.js';
import { seed, verdictOf, writeHostTranscript, type ReadOpts, type Verdict } from './_helpers/host-transcript.js';
import { dispose, hippo, project, type Project } from './_helpers/delivery-boundary.js';
import { upsertEntryRow } from '../src/store/entry-row.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { fire } from './_helpers/host-transcript.js';
import { parseTranscript } from '../scripts/z10/transcript.mjs';

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'z10-reconstruct.mjs');
const STAGES: DeliveryStage[] = ['load', 'eligible', 'gate', 'budget', 'limit', 'final'];
const REASONS: DeliveryRejectReason[] = ['budget', 'gate-below-threshold', 'gate-max-items', 'duplicate', 'scope', 'quality', 'limit'];
const CREATED = '2026-09-01T00:00:00.000Z';
const STATIC = 'aaaaaaaaaaaaaaaa';

interface Json { [key: string]: JsonValue }

let dir: string;
let tick = 0;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-z10-reader-'));
  initStore(dir);
  tick = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Event inputs are 10 s apart so the writer's duplicate window never joins two of them. */
function event(session: string, o: Partial<DeliveryEventInput> = {}): DeliveryEventInput {
  tick += 1;
  return {
    ts: new Date(Date.parse('2026-10-01T00:00:00.000Z') + tick * 10_000).toISOString(), tenantId: 'default', runtime: 'claude-code',
    eventType: 'prompt-submit', surface: 'hook', storeHash: blockHash(path.join(realpathOrResolve(path.dirname(path.resolve(dir))), path.basename(dir))), writeStore: 'local', projectHash: null,
    sessionId: session, sessionState: 'payload', hostTurnId: null, promptHash: blockHash(`prompt ${tick}`), promptLength: 5, queryHash: null,
    recallTraceId: null, blockState: 'sent', promptRecall: false, consideredCount: 1, filteredCount: 0, selectedCount: 1, emittedCount: 1,
    rejectedCount: 0, rejectedUnlisted: 0, sectionsShown: 0, sectionsDropped: 0, budgetTokens: 1000, selectedTokens: 10, injectedTokens: 10,
    staticHash: STATIC, recallHash: null, emittedHash: null, elapsedMs: 1, candidates: [], ...o,
  };
}

const row = (memoryId: string, o: Partial<DeliveryCandidateInput> = {}): DeliveryCandidateInput => ({
  memoryId, sourceStore: 'local', pool: 'pin', stage: 'final', outcome: 'emitted', reason: null, rank: 1, score: 1, tokens: 10, ...o,
});

function write(input: DeliveryEventInput): number {
  const db = openHippoDb(dir);
  try {
    const id = writeDeliveryEventOnHandle(db, input);
    expect(id).not.toBeNull();
    return Number(id);
  } finally {
    closeHippoDb(db);
  }
}

const read = (session: string, memory: string, extra: ReadOpts = {}) => verdictOf({ store: dir, session, memory, ...extra });
const present = (content = 'a lesson that was written before every turn here') => seed(dir, content, { created: CREATED });
// SAFETY: writeHostTranscript reads only the project's dir.
const transcript = (specs: Parameters<typeof writeHostTranscript>[1]): string => writeHostTranscript({ dir } as Project, specs, { noise: false });

describe('every ledger value, on rows from the real writer', () => {
  it('R1 every stage and every reject reason on a rejected row is copied verbatim', () => {
    const cases = STAGES.flatMap((stage) => REASONS.map((reason) => ({ stage, reason })));
    cases.forEach(({ stage, reason }, i) => {
      write(event(`r1-${i}`, { emittedCount: 0, rejectedCount: 1, candidates: [row(`mem_${i}`, { stage, reason, outcome: 'rejected', rank: null })] }));
    });
    expect(cases).toHaveLength(42);
    cases.forEach(({ stage, reason }, i) => {
      const v = read(`r1-${i}`, `mem_${i}`);
      expect([v.class, v.stage, v.cand_reason, v.reason]).toEqual(['rejected', stage, reason, reason]);
    });
  });

  it('R2 every block state maps per the table', () => {
    const m = present();
    write(event('r2-sent', { candidates: [row(m.id)] }));
    write(event('r2-reused', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    write(event('r2-mixed', { blockState: 'reused-recall-sent', candidates: [row(m.id, { outcome: 'reused' })] }));
    write(event('r2-empty', { blockState: 'empty', consideredCount: 0, selectedCount: 0, emittedCount: 0 }));
    write(event('r2-disabled', { blockState: 'disabled', consideredCount: 0, selectedCount: 0, emittedCount: 0 }));
    const got = ['sent', 'reused', 'mixed', 'empty', 'disabled'].map((s) => {
      const v = read(`r2-${s}`, m.id);
      return [v.class, v.reason];
    });
    expect(got).toEqual([
      ['delivery-unconfirmed', 'no-transcript'], ['delivery-unconfirmed', 'no-original'], ['delivery-unconfirmed', 'no-original'],
      ['not-retrieved', 'not-loaded'], ['rejected', 'block-disabled'],
    ]);
  });

  it('R3 a context row with no target row is indeterminate context-surface, and a rejected one is rejected', () => {
    const m = present();
    write(event('r3', { eventType: 'context', surface: 'context', promptHash: null, candidates: [] }));
    expect(read('r3', m.id)).toMatchObject({ class: 'indeterminate', reason: 'context-surface' });
    write(event('r3b', { eventType: 'context', surface: 'context', promptHash: null, emittedCount: 0, rejectedCount: 1, candidates: [row(m.id, { outcome: 'rejected', stage: 'limit', reason: 'limit', rank: null })] }));
    expect(read('r3b', m.id)).toMatchObject({ class: 'rejected', reason: 'limit' });
  });
});

describe('defensive reuse arms', () => {
  it('R4 a compaction row between a send and a reuse leaves the reuse unconfirmed compacted-since-send', () => {
    const m = present();
    const first = write(event('r4', { emittedHash: blockHash('the block'), candidates: [row(m.id)] }));
    write(event('r4', { eventType: 'pre-compact', promptHash: null, candidates: [], selectedCount: 0, emittedCount: 0 }));
    const third = write(event('r4', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r4', m.id);
    expect(v.notes.some((n: string) => n.startsWith('pre-compact:'))).toBe(true);
    expect([v.turns.map((t) => t.event_id), v.turns[1].why, v.turns[1].delivery]).toEqual([[first, third], 'compacted-since-send', 'unconfirmed']);
  });

  it('R5 a numbered reused row whose duplicate was sent and emitted the target is confirmed through the duplicate', () => {
    const m = present();
    const block = 'the block both parallel fires carried';
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r5', { ts: new Date(t).toISOString(), promptHash, blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const b = write(event('r5', { ts: new Date(t + 500).toISOString(), promptHash, emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([[a, 1, null], [b, null, a]]);
    const v = read('r5', m.id, { transcript: transcript([{ prompt: 'one prompt fired twice', attach: block }]) });
    expect([v.class, v.turns[0].duplicates, v.turns[0].delivery]).toEqual(['application-unknown', [b], 'confirmed']);
  });

  it('R17 a recall-only attachment does not confirm a pin whose duplicate row printed the full block', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r17', { ts: new Date(t).toISOString(), promptHash, blockState: 'reused-recall-sent', emittedHash: blockHash('the recall block'), candidates: [row(m.id, { outcome: 'reused' })] }));
    const b = write(event('r17', { ts: new Date(t + 500).toISOString(), promptHash, emittedHash: blockHash('the full block'), candidates: [row(m.id)] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([[a, 1, null], [b, null, a]]);
    const v = read('r17', m.id, { transcript: transcript([{ prompt: 'one prompt fired twice', attach: 'the recall block' }]) });
    expect([v.class, v.reason, v.turns[0].delivery, v.turns[0].why]).toEqual(['delivery-unconfirmed', 'no-attachment', 'unconfirmed', 'no-attachment']);
  });

  it('R6 a reused turn whose latest send had another static hash has no original', () => {
    const m = present();
    write(event('r6', { staticHash: 'bbbbbbbbbbbbbbbb', emittedHash: blockHash('old block'), candidates: [row(m.id)] }));
    const second = write(event('r6', { blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const v = read('r6', m.id);
    expect([v.turns[1].event_id, v.turns[1].why]).toEqual([second, 'no-original']);
  });
});

describe('fold edge cases', () => {
  it('R7 only range turns fold to indeterminate, and a valid label on them is unused', () => {
    const m = present();
    write(event('r7', { candidates: [], selectedCount: 0, emittedCount: 0, rejectedCount: 3, rejectedUnlisted: 3 }));
    const label = { session_id: 'r7', memory_id: m.id, application: 'observed', signal: 'resolved-check', evidence: 'a passing run' };
    const v = read('r7', m.id, { labels: [label] });
    expect([v.class, v.reason, v.notes]).toEqual(['indeterminate', 'undecided', ['label-unused']]);
  });

  it('R8 a store without the ledger table is indeterminate no-ledger-table', () => {
    const bare = path.join(dir, 'bare');
    fs.mkdirSync(bare);
    const db = new DatabaseSync(path.join(bare, 'hippo.db'));
    db.exec('CREATE TABLE memories (id TEXT)');
    db.close();
    const v = verdictOf({ store: bare, session: 's', memory: 'mem_x' });
    expect([v.class, v.reason, v.memory_id]).toEqual(['indeterminate', 'no-ledger-table', 'mem_x']);
  });

  it('R9 a key two memories hold is indeterminate key-ambiguous', () => {
    seed(dir, 'the shared phrase appears in the first lesson', { created: CREATED });
    seed(dir, 'the shared phrase appears in the second lesson', { created: CREATED });
    write(event('r9', { candidates: [] }));
    const v = verdictOf({ store: dir, session: 'r9', key: 'shared phrase' });
    expect([v.class, v.reason, v.memory_id]).toEqual(['indeterminate', 'key-ambiguous', null]);
  });

  it('R10 a memory forgotten after the first turn is indeterminate forgotten', () => {
    const m = present();
    write(event('r10', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    expect(deleteEntry(dir, m.id)).toBe(true);
    const v = read('r10', m.id);
    expect([v.class, v.reason]).toEqual(['indeterminate', 'forgotten']);
  });

  it('R10b a memory forgotten in a session with no rows is indeterminate forgotten, not not-written', () => {
    const m = present();
    expect(deleteEntry(dir, m.id)).toBe(true);
    const v = read('r10b', m.id);
    expect([v.class, v.reason, v.turn]).toEqual(['indeterminate', 'forgotten', null]);
  });

  it('R19 a memory with no row, no forget row and a trace in another session is indeterminate forgotten', () => {
    write(event('r19-other', { candidates: [row('mem_gone')] }));
    write(event('r19', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    const v = read('r19', 'mem_gone');
    expect([v.class, v.reason]).toEqual(['indeterminate', 'forgotten']);
  });

  it('R24 a disabled turn before the lesson was written is not-written, and after it is rejected', () => {
    const ts = new Date('2026-10-02T00:00:00.000Z');
    const id = write(event('r24', { ts: ts.toISOString(), blockState: 'disabled', consideredCount: 0, selectedCount: 0, emittedCount: 0 }));
    const later = seed(dir, 'a lesson written a minute after the disabled turn', { created: new Date(ts.getTime() + 60_000).toISOString() });
    const earlier = seed(dir, 'a lesson written a minute before the disabled turn', { created: new Date(ts.getTime() - 60_000).toISOString() });
    const after = read('r24', later.id);
    expect([after.class, after.reason, after.turns[0].event_id]).toEqual(['not-written', 'written-after', id]);
    const before = read('r24', earlier.id);
    expect([before.class, before.reason, before.turns[0].event_id]).toEqual(['rejected', 'block-disabled', id]);
  });

  it('R30 a shared copy with no remember row has no presence time, so a turn with no candidate row is indeterminate presence-unknown', () => {
    const copy = { ...createMemory('a lesson copied in without an audit row', { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), created: CREATED, source: 'shared:elsewhere:2026-10-05T00:00:00.000Z' };
    const db = openHippoDb(dir);
    try {
      upsertEntryRow(db, copy);
    } finally {
      closeHippoDb(db);
    }
    write(event('r30', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    const v = read('r30', copy.id);
    expect([v.class, v.reason, v.turns[0].range]).toEqual(['indeterminate', 'presence-unknown', ['not-written', 'not-retrieved']]);
  });

  it('R31 a lesson in no store and no candidate row is indeterminate global-unread when the global store was skipped, and not-written when it was read', () => {
    write(event('r31', { candidates: [], selectedCount: 0, emittedCount: 0 }));
    expect(read('r31', 'mem_nowhere', { global: false })).toMatchObject({ class: 'indeterminate', reason: 'global-unread' });
    const g = path.join(dir, 'g31');
    fs.mkdirSync(g);
    initStore(g);
    expect(read('r31', 'mem_nowhere', { global: g })).toMatchObject({ class: 'not-written', reason: 'no-row' });
  });

  it('R25 a reuse after a group whose sent row was a duplicate is confirmed through that group', () => {
    const m = present();
    const block = 'the block the duplicate row sent';
    const promptHash = blockHash('prompt a');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r25', { ts: new Date(t).toISOString(), promptHash, blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const a2 = write(event('r25', { ts: new Date(t + 500).toISOString(), promptHash, emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const c = write(event('r25', { ts: new Date(t + 5_000).toISOString(), promptHash: blockHash('prompt c'), blockState: 'reused', candidates: [row(m.id, { outcome: 'reused' })] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq !== null, r.duplicate_of])).toEqual([[a, true, null], [a2, false, a], [c, true, null]]);
    const v = read('r25', m.id, { transcript: transcript([{ prompt: 'prompt a', attach: block }, { prompt: 'prompt c' }]) });
    expect([v.class, v.turns[1].event_id, v.turns[1].delivery, v.turns[1].via_event_id]).toEqual(['application-unknown', c, 'confirmed', a]);
  });

  it('R20 a valid label on a not-written or key-ambiguous read is noted, not applied', () => {
    const label = { session_id: 'r20', memory_id: 'mem_never', application: 'observed', signal: 'resolved-check', evidence: 'a passing run' };
    const never = read('r20', 'mem_never', { labels: [label], global: path.join(dir, 'no-global') });
    expect([never.class, never.reason, never.notes, never.label]).toEqual(['not-written', 'no-row', ['label-conflict'], null]);
    const first = seed(dir, 'the shared phrase appears in the first lesson', { created: CREATED });
    seed(dir, 'the shared phrase appears in the second lesson', { created: CREATED });
    const amb = verdictOf({ store: dir, session: 'r20', key: 'shared phrase', labels: [{ ...label, memory_id: first.id }] });
    expect([amb.class, amb.reason, amb.notes]).toEqual(['indeterminate', 'key-ambiguous', ['label-unused']]);
  });

  it('R21 a row from another store and its duplicate are both noted as dropped', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r21', { ts: new Date(t).toISOString(), promptHash, storeHash: 'aaaaaaaaaaaaaaaa', candidates: [row(m.id)] }));
    const b = write(event('r21', { ts: new Date(t + 500).toISOString(), promptHash, candidates: [row(m.id)] }));
    const check = new DatabaseSync(path.join(dir, 'hippo.db'), { readOnly: true });
    const rows = check.prepare('SELECT id, turn_seq, duplicate_of FROM delivery_events ORDER BY id').all();
    check.close();
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([[a, 1, null], [b, null, a]]);
    const v = read('r21', m.id);
    expect(v.notes).toEqual([`foreign-store:${a}`, `orphan-duplicate:${b}`]);
  });

  it('R23 a duplicate of a row that is not a main row is noted (the writer cannot produce the pair, so one UPDATE unnumbers the original)', () => {
    const m = present();
    const promptHash = blockHash('one prompt fired twice');
    const t = Date.parse('2026-10-02T00:00:00.000Z');
    const a = write(event('r23', { ts: new Date(t).toISOString(), promptHash, candidates: [row(m.id)] }));
    const b = write(event('r23', { ts: new Date(t + 500).toISOString(), promptHash, candidates: [row(m.id)] }));
    const db = new DatabaseSync(path.join(dir, 'hippo.db'));
    const raw = () => db.prepare('SELECT id, turn_seq, duplicate_of, session_state FROM delivery_events ORDER BY id').all().map((r) => [r.id, r.turn_seq, r.duplicate_of, r.session_state]);
    expect(raw()).toEqual([[a, 1, null, 'payload'], [b, null, a, 'payload']]);
    db.prepare('UPDATE delivery_events SET turn_seq = NULL WHERE id = ?').run(a);
    expect(raw()).toEqual([[a, null, null, 'payload'], [b, null, a, 'payload']]);
    db.close();
    expect(read('r23', m.id).notes).toEqual([`unnumbered:${a}`, `orphan-duplicate:${b}`]);
  });

  it('R11 label validation: bad fields, other sessions and duplicates', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r11', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const ok = { session_id: 'r11', memory_id: m.id, application: 'observed', signal: 'revert', evidence: 'git revert abc' };
    const run = (labels: Json[]) => read('r11', m.id, { transcript: t, labels });
    for (const signal of ['failed-check', 'explicit-correction', 'revert', 'repeated-error']) {
      expect(run([{ ...ok, signal }])).toMatchObject({ class: 'applied-but-wrong', label: { signal } });
    }
    expect(run([{ ...ok, signal: 'guess' }])).toMatchObject({ class: 'application-unknown', notes: ['label-error:signal'], label: null });
    expect(run([{ ...ok, evidence: '  ' }]).notes).toEqual(['label-error:evidence']);
    expect(run([{ ...ok, session_id: 'other' }, { ...ok, memory_id: 'other' }])).toMatchObject({ class: 'application-unknown', notes: [] });
    expect(run([ok, { ...ok, signal: 'failed-check' }])).toMatchObject({ class: 'application-unknown', notes: ['label-error:duplicate'], label: null });
    expect(run([{ ...ok, application: 'unknown', signal: 'unknown', evidence: '' }]).class).toBe('application-unknown');
    expect(run([ok]).class).toBe('applied-but-wrong');
  });
});

describe('a lesson copied to the global store', () => {
  let p: Project;
  afterEach(() => dispose(p));

  it('R29 a lesson shared after the turn keeps its old created time, and the copy still reads not-written written-after', () => {
    p = project();
    const note = 'office note: the coffee machine schedule changes for team lunch on friday';
    const target = seed(p.hippoRoot, `${note} oldest`, { created: '2026-05-01T00:00:00.000Z' });
    for (let i = 0; i < 6; i++) seed(p.hippoRoot, `${note} ${i}`, { created: `2026-06-0${i + 1}T00:00:00.000Z` });
    fire(p, 'r29', 'first question about deploys');
    const shared = hippo(p, ['share', target.id, '--force']);
    expect(shared.status, shared.stderr).toBe(0);
    const copyId = /Shared \[(\S+)\] to global store\./.exec(shared.stdout)?.[1] ?? '';
    expect(copyId).not.toBe('');
    const db = new DatabaseSync(path.join(p.globalRoot, 'hippo.db'), { readOnly: true });
    const raw = db.prepare('SELECT created, source FROM memories WHERE id = ?').get(copyId);
    db.close();
    expect([raw?.created, String(raw?.source).startsWith('shared:')]).toEqual([target.created, true]);
    const v = verdictOf({ store: p.hippoRoot, session: 'r29', memory: copyId, global: p.globalRoot });
    expect([v.class, v.reason, v.memory_store, v.turns.map((t) => t.cand_reason)]).toEqual(['not-written', 'written-after', 'global', [null]]);
  });
});

describe('pairing', () => {
  it('R18 transcript lines of another session are skipped and counted, and lines of this session pair', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r18', { promptHash: blockHash('a prompt'), emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const lines = (sessionId: string) => {
      const user = JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'a prompt' } });
      const hook = JSON.stringify({ type: 'attachment', sessionId, attachment: { type: 'hook_additional_context', content: [block], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' } });
      return `${user}
${hook}
`;
    };
    const file = (name: string, sessionId: string): string => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(f, lines(sessionId));
      return f;
    };
    const foreign = read('r18', m.id, { transcript: file('foreign', 'someone-else') });
    expect([foreign.class, foreign.notes]).toEqual(['delivery-unconfirmed', ['transcript-foreign-lines:2']]);
    expect(foreign.turns[0].delivery).toBe('unconfirmed');
    const own = read('r18', m.id, { transcript: file('own', 'r18') });
    expect([own.class, own.notes, own.turns[0].delivery]).toEqual(['application-unknown', [], 'confirmed']);
  });

  it('R22 torn and non-object transcript lines are skipped and noted, and a torn attachment reads unconfirmed', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r22', { promptHash: blockHash('a prompt'), emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const user = JSON.stringify({ type: 'user', message: { role: 'user', content: 'a prompt' } });
    const hook = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [block], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' } });
    const file = (name: string, ...lines: string[]): string => {
      const f = path.join(dir, `${name}.jsonl`);
      fs.writeFileSync(f, `${lines.join('\n')}\n`);
      return f;
    };
    const fields = (v: Verdict) => [v.class, v.turn, v.turns[0].delivery];
    const clean = read('r22', m.id, { transcript: file('clean', user, hook) });
    expect(clean.class).toBe('application-unknown');
    expect(clean.notes.some((n: string) => n.startsWith('transcript-skipped-lines'))).toBe(false);
    const noisy = read('r22', m.id, { transcript: file('noisy', '{"type":"user",', user, 'null', hook) });
    expect(fields(noisy)).toEqual(fields(clean));
    expect(noisy.notes).toContain('transcript-skipped-lines:2');
    const torn = read('r22', m.id, { transcript: file('torn', user, hook.slice(0, hook.length / 2)) });
    expect(torn.class).toBe('delivery-unconfirmed');
    expect(torn.notes).toContain('transcript-skipped-lines:1');
  });

  it('R15 a sent turn whose prompt hash and attachment match no transcript prompt is delivery-unconfirmed no-paired-prompt', () => {
    const m = present();
    const block = 'the block that was sent';
    const id = write(event('r15', { promptHash: blockHash('the payload prompt'), emittedHash: blockHash(block), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a typed line one', fired: false }, { prompt: 'a typed line two', fired: false }]);
    const v = read('r15', m.id, { transcript: t });
    expect([v.class, v.reason, v.turn, v.turns[0].paired_by, v.notes.some((n: string) => n.startsWith('gap:'))])
      .toEqual(['delivery-unconfirmed', 'no-paired-prompt', { event_id: id, turn_seq: 1 }, null, false]);
  });
});

describe('the transcript parser', () => {
  it('R12 every candidate kind, an image prompt, tool results, meta, summary and a compaction line', () => {
    const user = (content: string | Json[], extra: Json = {}) => JSON.stringify({ type: 'user', message: { role: 'user', content }, ...extra });
    const hook = (text: string, extra: Json = {}) => JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [text, 'second part'], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', ...extra } });
    const lines = [
      user('<command-name>/clear</command-name>'), user('<local-command-stdout>ok</local-command-stdout>'), user('<local-command-caveat>x</local-command-caveat>'),
      user('<bash-input>ls</bash-input>'), user('<bash-stdout>a</bash-stdout>'), user('<bash-stderr>b</bash-stderr>'), user('<task-notification>done</task-notification>'),
      user('a plain prompt'), hook('hippo block'), hook('other event', { hookEvent: 'SessionStart' }), JSON.stringify({ type: 'attachment', attachment: { type: 'file' } }),
      user('meta line', { isMeta: true }), user('summary line', { isCompactSummary: true }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'out' }]), user([{ type: 'text', text: 'see' }, { type: 'text', text: 'this' }, { type: 'image', source: {} }]),
      user([{ type: 'image', source: {} }]), JSON.stringify({ type: 'system', subtype: 'compact_boundary' }), 'not json', '', user('after the compaction'),
    ];
    const parsed = parseTranscript(lines.join('\n'));
    expect(parsed.candidates.map((c: { kind: string }) => c.kind)).toEqual([
      'command-name', 'local-command-stdout', 'local-command-caveat', 'bash-input', 'bash-stdout', 'bash-stderr', 'task-notification', 'prompt', 'prompt', 'prompt',
    ]);
    const [plain, image, after] = parsed.candidates.slice(7);
    expect([plain.attachments, plain.fired, image.text, image.image, after.fired]).toEqual([['hippo block\nsecond part'], true, 'see\nthis', true, false]);
    expect([parsed.compactions, parsed.skipped]).toEqual([[{ pos: 17 }], [18]]);
    expect(parsed.candidates.map((c: { queued: boolean }) => c.queued)).toEqual(Array(10).fill(false));
  });

  it('R16 a queued_command attachment is a candidate kinded by its text, and the hooks under it are its own', () => {
    const attach = (a: Json) => JSON.stringify({ type: 'attachment', attachment: a });
    const queued = (prompt: string | Json[], extra: Json = {}) => attach({ type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' }, ...extra });
    const hook = (text: string) => attach({ type: 'hook_additional_context', content: [text], hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit' });
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'a typed prompt' } }),
      queued('<task-notification>done</task-notification>', { commandMode: 'task-notification' }), hook('h1'),
      queued('<cross-session-message from="x">hi</cross-session-message>'), hook('h2'),
      queued('<agent-message from="x">hi</agent-message>'), hook('h3'),
      queued('a plain human prompt'), hook('h4'),
      queued('ls', { commandMode: 'bash' }),
      queued([{ type: 'text', text: 'blocks prompt' }]),
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<command-message>run the skill</command-message>' } }), hook('h5'),
    ];
    const { candidates } = parseTranscript(lines.join('\n'));
    expect(candidates.map((c: { kind: string }) => c.kind)).toEqual(['prompt', 'task-notification', 'cross-session-message', 'agent-message', 'prompt', 'queued-bash', 'prompt', 'prompt']);
    expect(candidates.map((c: { queued: boolean }) => c.queued)).toEqual([false, true, true, true, true, true, true, false]);
    expect(candidates.map((c: { attachments: string[] }) => c.attachments)).toEqual([[], ['h1'], ['h2'], ['h3'], ['h4'], [], [], ['h5']]);
    expect(candidates[6].text).toBe('blocks prompt');
    expect([candidates[7].kind, candidates[7].fired]).toEqual(['prompt', true]);
  });
});

describe('the command line', () => {
  it('R13 the script prints the verdict the function returns', () => {
    const m = present();
    const block = 'the block that was sent';
    write(event('r13', { emittedHash: blockHash(block), promptHash: blockHash('a prompt'), candidates: [row(m.id)] }));
    const t = transcript([{ prompt: 'a prompt', attach: block }]);
    const r = spawnSync(process.execPath, [SCRIPT, '--store', dir, '--session', 'r13', '--memory', m.id, '--transcript', t, '--no-global'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(JSON.stringify(read('r13', m.id, { transcript: t }))));
    expect(JSON.parse(r.stdout).class).toBe('application-unknown');
  });

  it.each([
    ['no arguments', []],
    ['both a memory and a key', ['--store', 'x', '--session', 's', '--memory', 'a', '--key', 'b']],
    ['neither a memory nor a key', ['--store', 'x', '--session', 's']],
    ['an unknown flag', ['--store', 'x', '--session', 's', '--memory', 'a', '--bogus']],
    ['a flag with no value', ['--store', 'x', '--session', 's', '--memory']],
  ])('R14 %s exits 2 with usage on stderr', (_name, args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
    expect([r.status, r.stdout, r.stderr.includes('usage:')]).toEqual([2, '', true]);
  });
});

describe('store paths through a link', () => {
  const PROMPT = 'first question about deploys';
  let p: Project;
  afterEach(() => dispose(p));

  /** A junction to `target`, or null when this machine cannot create one. */
  function link(target: string, l: string): string | null {
    try {
      fs.symlinkSync(target, l, 'junction');
    } catch (err) {
      // SAFETY: fs.symlinkSync throws only errno exceptions.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return null;
      throw err;
    }
    return l;
  }

  const rawRows = (root: string) => {
    const db = new DatabaseSync(path.join(root, 'hippo.db'), { readOnly: true });
    try {
      return db.prepare('SELECT store_hash, write_store FROM delivery_events').all();
    } finally {
      db.close();
    }
  };

  it('R26 a project reached through a linked folder', (ctx) => {
    p = project();
    const L = link(p.proj, path.join(p.dir, 'proj-link'));
    if (L === null) return ctx.skip();
    try {
      const r = fire(p, 'r26', PROMPT, { cwd: L });
      const rows = rawRows(p.hippoRoot);
      const want = blockHash(path.join(realpathOrResolve(p.proj), '.hippo'));
      expect(rows.map((x) => x.store_hash)).toEqual([want]);
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r26' });
      const db = new DatabaseSync(path.join(p.hippoRoot, 'hippo.db'), { readOnly: true });
      const id = String(db.prepare('SELECT id FROM memories WHERE pinned = 1').get()?.id);
      db.close();
      for (const store of [p.hippoRoot, path.join(L, '.hippo')]) {
        const v = verdictOf({ store, session: 'r26', memory: id, transcript: t });
        expect(v.class).toBe('application-unknown');
        expect(v.notes.some((n: string) => n.startsWith('foreign-store'))).toBe(false);
        expect(v.store_hash).toBe(want);
      }
    } finally {
      fs.unlinkSync(L);
    }
  });

  it('R27 the global store through a linked HIPPO_HOME', (ctx) => {
    p = project();
    initStore(p.globalRoot);
    fs.writeFileSync(path.join(p.globalRoot, 'config.json'), JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }));
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const G = link(p.globalRoot, path.join(p.dir, 'global-link'));
    if (G === null) return ctx.skip();
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      const r = fire(p, 'r27', PROMPT, { cwd: bare, env: { HIPPO_HOME: G } });
      const want = blockHash(path.resolve(G));
      expect(rawRows(p.globalRoot).map((x) => [x.store_hash, x.write_store])).toEqual([[want, 'global']]);
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r27' });
      const v = verdictOf({ store: G, global: G, session: 'r27', memory: g.id, transcript: t });
      expect(v.class).toBe('application-unknown');
      expect(v.notes.some((n: string) => n.startsWith('foreign-store'))).toBe(false);
      expect(v.store_hash).toBe(want);
    } finally {
      fs.unlinkSync(G);
    }
  });

  it('R28 the command line classifies the global store behind a linked HIPPO_HOME under --no-global, with the link above the store', (ctx) => {
    p = project();
    initStore(p.globalRoot);
    fs.writeFileSync(path.join(p.globalRoot, 'config.json'), JSON.stringify({ deliveryLedger: { enabled: true }, pinnedInject: { promptRecall: false } }));
    const g = seed(p.globalRoot, 'PINNED: the global release checklist lists every region first', { pinned: true });
    const L = link(p.dir, `${p.dir}-link`);
    if (L === null) return ctx.skip();
    const G = path.join(L, 'global');
    try {
      const bare = path.join(p.dir, 'bare');
      fs.mkdirSync(bare);
      const r = fire(p, 'r28', PROMPT, { cwd: bare, env: { HIPPO_HOME: G } });
      const t = writeHostTranscript(p, [{ prompt: PROMPT, stdout: r.stdout }], { name: 'r28' });
      const out = spawnSync(process.execPath, [SCRIPT, '--store', G, '--session', 'r28', '--memory', g.id, '--transcript', t, '--no-global'], { encoding: 'utf8', env: { ...process.env, HIPPO_HOME: G } });
      expect(out.status, out.stderr).toBe(0);
      // SAFETY: the script prints exactly the verdict shape.
      const v = JSON.parse(out.stdout) as Verdict;
      expect(v.class).toBe('application-unknown');
      expect(v.notes.some((n) => n.startsWith('foreign-store'))).toBe(false);
      expect(v.store_hash).toBe(blockHash(path.resolve(G)));
    } finally {
      fs.unlinkSync(L);
    }
  });
});
