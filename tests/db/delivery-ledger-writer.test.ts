// The delivery ledger writer (src/store/recall-trace.ts) and the recorder's row building, on a real SQLite store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../../src/db/index.js';
import {
  deliveryPruneSchedule,
  writeDeliveryEventOnHandle,
  writeDeliveryEventVia,
} from '../../src/store/sqlite/recall-trace.js';
import { readDeliveryEvents } from '../_helpers/delivery-events.js';
import { createDeliveryRecorder } from '../../src/api/delivery-recorder.js';
import { DELIVERY_LEDGER_VERSION } from '../../src/base/session/delivery.js';
import type { DeliveryEventInput, DeliveryRejectReason, DeliveryStage } from '../../src/base/session/delivery.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/memory.js';
import { runWithRequestId } from '../../src/base/util/request-scope.js';
import { countMatching, recordStatements, type StatementLog } from '../_helpers/count-statements.js';
import { sqliteStore, sqliteSyncStore } from '../../src/store/sqlite/store.js';
import { makeRoot } from '../_helpers/make-root.js';
import { handlesOf } from '../../src/store/sqlite/handles.js';

// A prompt hook waits a second for a lock in all; the ledger may spend a fraction of it.
const MAX_LEDGER_WAIT_MS = 100;
// The ledger keeps 90 days and lists 16 rejected rows; pinned here so a change to either shows up as a test edit.
const DELIVERY_LEDGER_RETENTION_DAYS = 90;
const DELIVERY_REJECTED_ROW_CAP = 16;

/** One write attempt, made under a short lock wait: a bounded delay on any runner, which elapsed time is not. */
function expectOneShortWait(statements: readonly string[]): void {
  expect(countMatching(statements, /^BEGIN IMMEDIATE$/)).toBe(1);
  const waitsSet = statements
    .slice(0, statements.indexOf('BEGIN IMMEDIATE'))
    .filter((sql) => sql.startsWith('PRAGMA busy_timeout = '));
  expect(Number(waitsSet.at(-1)?.split(' = ')[1])).toBeLessThanOrEqual(MAX_LEDGER_WAIT_MS);
}

let root: string;
let db: DatabaseSyncLike;

function event(overrides: Partial<DeliveryEventInput> = {}): DeliveryEventInput {
  return {
    ts: '2026-09-01T00:00:00.000Z',
    tenantId: 'default',
    runtime: 'claude-code',
    eventType: 'prompt-submit',
    surface: 'hook',
    storeHash: 'aaaaaaaaaaaaaaaa',
    writeStore: 'local',
    projectHash: null,
    sessionId: 'sess-1',
    sessionState: 'payload',
    hostTurnId: null,
    promptHash: 'bbbbbbbbbbbbbbbb',
    promptLength: 10,
    queryHash: null,
    recallTraceId: null,
    blockState: 'sent',
    promptRecall: false,
    consideredCount: 1,
    filteredCount: 0,
    selectedCount: 1,
    emittedCount: 1,
    rejectedCount: 0,
    rejectedUnlisted: 0,
    sectionsShown: 0,
    sectionsDropped: 0,
    budgetTokens: 1500,
    selectedTokens: 10,
    injectedTokens: 12,
    staticHash: 'cccccccccccccccc',
    recallHash: null,
    emittedHash: 'dddddddddddddddd',
    elapsedMs: 3,
    candidates: [
      {
        memoryId: 'mem-1',
        sourceStore: 'local',
        pool: 'pin',
        stage: 'final',
        outcome: 'emitted',
        reason: null,
        rank: 1,
        score: 1,
        tokens: 10,
      },
    ],
    ...overrides,
  };
}

function count(table: string): number {
  // SAFETY: a single COUNT(*) aggregate aliased `c`.
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function at(ms: number): string {
  return new Date(Date.parse('2026-09-01T00:00:00.000Z') + ms).toISOString();
}

beforeEach(() => {
  root = makeRoot('delivery-writer');
  db = openHippoDb(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeHippoDb(db);
});

describe('writeDeliveryEventOnHandle', () => {
  it('writes the event and its candidates, and numbers turns per session', () => {
    const first = writeDeliveryEventOnHandle(db, event({ promptHash: 'p1' }));
    const second = writeDeliveryEventOnHandle(db, event({ promptHash: 'p2', ts: at(5000) }));
    const other = writeDeliveryEventOnHandle(db, event({ promptHash: 'p1', sessionId: 'sess-2' }));
    expect(first).not.toBeNull();
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of, r.ledger_version])).toEqual([
      [first, 1, null, DELIVERY_LEDGER_VERSION],
      [second, 2, null, DELIVERY_LEDGER_VERSION],
    ]);
    expect(rows[0].candidates).toEqual([
      {
        event_id: first,
        tenant_id: 'default',
        memory_id: 'mem-1',
        source_store: 'local',
        pool: 'pin',
        stage: 'final',
        outcome: 'emitted',
        reason: null,
        cand_rank: 1,
        score: 1,
        tokens: 10,
      },
    ]);
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.id, r.turn_seq])).toEqual([[other, 1]]);
  });

  it('flags a repeated host turn id as a duplicate of the first, and a new turn id as a new turn', () => {
    const first = writeDeliveryEventOnHandle(db, event({ runtime: 'codex', hostTurnId: 'turn-a' }));
    const repeat = writeDeliveryEventOnHandle(db, event({ runtime: 'codex', hostTurnId: 'turn-a', ts: at(60_000) }));
    const next = writeDeliveryEventOnHandle(db, event({ runtime: 'codex', hostTurnId: 'turn-b', ts: at(500) }));
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [repeat, null, first],
      [next, 2, null],
    ]);
  });

  it('without a turn id, flags the same prompt within the window either side, never past it', () => {
    const first = writeDeliveryEventOnHandle(db, event({ ts: at(10_000) }));
    const before = writeDeliveryEventOnHandle(db, event({ ts: at(8_500) }));
    const after = writeDeliveryEventOnHandle(db, event({ ts: at(12_000) }));
    const far = writeDeliveryEventOnHandle(db, event({ ts: at(20_000) }));
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [before, null, first],
      [after, null, first],
      [far, 2, null],
    ]);
  });

  it('gives no turn number and no duplicate check to missing-session and sub-agent events', () => {
    writeDeliveryEventOnHandle(db, event({ sessionId: null, sessionState: 'missing' }));
    writeDeliveryEventOnHandle(db, event({ sessionId: null, sessionState: 'missing' }));
    const parent = writeDeliveryEventOnHandle(db, event());
    writeDeliveryEventOnHandle(db, event({ sessionState: 'subagent' }));
    const missing = readDeliveryEvents(db, 'default', null);
    expect(missing.map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
      [null, null],
      [null, null],
    ]);
    const inSession = readDeliveryEvents(db, 'default', 'sess-1');
    expect(inSession.map((r) => [r.id === parent, r.session_state, r.turn_seq, r.duplicate_of])).toEqual([
      [true, 'payload', 1, null],
      [false, 'subagent', null, null],
    ]);
  });

  it('numbers two context rows 500 ms apart, since a context row has no prompt or host turn to match', () => {
    const context = (overrides: Partial<DeliveryEventInput> = {}): DeliveryEventInput =>
      event({
        eventType: 'context',
        surface: 'context',
        sessionState: 'env',
        promptHash: null,
        promptLength: 0,
        ...overrides,
      });
    writeDeliveryEventOnHandle(db, context());
    writeDeliveryEventOnHandle(db, context({ ts: at(500) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  const boundary = (
    eventType: 'pre-compact' | 'compact-resume' | 'session-end',
    overrides: Partial<DeliveryEventInput> = {},
  ): DeliveryEventInput => event({ eventType, promptHash: null, promptLength: 0, ...overrides });

  describe.each(['pre-compact', 'compact-resume', 'session-end'] as const)('%s boundary duplicates', (type) => {
    it('flags a second prompt-less event 500 ms later as a duplicate of the first', () => {
      const first = writeDeliveryEventOnHandle(db, boundary(type));
      const second = writeDeliveryEventOnHandle(db, boundary(type, { ts: at(500) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
        [first, 1, null],
        [second, null, first],
      ]);
    });

    it('numbers the same pair 3000 ms apart as turns 1 and 2', () => {
      writeDeliveryEventOnHandle(db, boundary(type));
      writeDeliveryEventOnHandle(db, boundary(type, { ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
        [1, null],
        [2, null],
      ]);
    });

    it('with one host turn id, flags 500 ms apart and numbers 3000 ms apart', () => {
      const first = writeDeliveryEventOnHandle(db, boundary(type, { hostTurnId: 'turn-a' }));
      const near = writeDeliveryEventOnHandle(db, boundary(type, { hostTurnId: 'turn-a', ts: at(500) }));
      const far = writeDeliveryEventOnHandle(db, boundary(type, { hostTurnId: 'turn-a', ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
        [first, 1, null],
        [near, null, first],
        [far, 2, null],
      ]);
    });

    it('measures the window from the numbered row, so a third fire 1500 ms after a duplicate is numbered', () => {
      const first = writeDeliveryEventOnHandle(db, boundary(type));
      writeDeliveryEventOnHandle(db, boundary(type, { ts: at(1500) }));
      writeDeliveryEventOnHandle(db, boundary(type, { ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
        [1, null],
        [null, first],
        [2, null],
      ]);
    });

    it('gives a missing-session or sub-agent boundary no number and no duplicate', () => {
      writeDeliveryEventOnHandle(db, boundary(type, { sessionId: null, sessionState: 'missing' }));
      writeDeliveryEventOnHandle(db, boundary(type, { sessionId: null, sessionState: 'missing', ts: at(500) }));
      writeDeliveryEventOnHandle(db, boundary(type, { sessionState: 'subagent' }));
      writeDeliveryEventOnHandle(db, boundary(type, { sessionState: 'subagent', ts: at(500) }));
      expect(readDeliveryEvents(db, 'default', null).map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
        [null, null],
        [null, null],
      ]);
      expect(
        readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.session_state, r.turn_seq, r.duplicate_of]),
      ).toEqual([
        ['subagent', null, null],
        ['subagent', null, null],
      ]);
    });
  });

  it('keeps numbering a prompt-less prompt-submit pair 500 ms apart', () => {
    writeDeliveryEventOnHandle(db, event({ promptHash: null, promptLength: 0 }));
    writeDeliveryEventOnHandle(db, event({ promptHash: null, promptLength: 0, ts: at(500) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it('still flags a prompt-submit pair with one turn id 3000 ms apart', () => {
    const first = writeDeliveryEventOnHandle(db, event({ hostTurnId: 'turn-a' }));
    const repeat = writeDeliveryEventOnHandle(db, event({ hostTurnId: 'turn-a', ts: at(3000) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [repeat, null, first],
    ]);
  });

  it('numbers each event type on its own, and never matches another session', () => {
    writeDeliveryEventOnHandle(db, event({ promptHash: 'p1' }));
    writeDeliveryEventOnHandle(db, boundary('pre-compact', { ts: at(100) }));
    writeDeliveryEventOnHandle(db, boundary('compact-resume', { ts: at(200) }));
    writeDeliveryEventOnHandle(db, boundary('pre-compact', { sessionId: 'sess-2', ts: at(300) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.event_type, r.turn_seq, r.duplicate_of])).toEqual([
      ['prompt-submit', 1, null],
      ['pre-compact', 1, null],
      ['compact-resume', 1, null],
    ]);
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.event_type, r.turn_seq, r.duplicate_of])).toEqual([
      ['pre-compact', 1, null],
    ]);
  });

  it('prunes events past the retention window, with their candidates', () => {
    writeDeliveryEventOnHandle(db, event({ ts: '2026-01-01T00:00:00.000Z', promptHash: 'old' }));
    expect(count('delivery_candidates')).toBe(1);
    const later = new Date(
      Date.parse('2026-01-01T00:00:00.000Z') + (DELIVERY_LEDGER_RETENTION_DAYS + 1) * 86_400_000,
    ).toISOString();
    const kept = writeDeliveryEventOnHandle(db, event({ ts: later, promptHash: 'new' }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.id)).toEqual([kept]);
    expect(count('delivery_candidates')).toBe(1);
  });

  it('a write under a far-future fake time prunes no real rows', () => {
    const real = writeDeliveryEventOnHandle(db, event({ ts: new Date().toISOString(), promptHash: 'real' }));
    const fake = writeDeliveryEventOnHandle(db, event({ ts: '2099-01-01T00:00:00.000Z', promptHash: 'fake' }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.id)).toEqual([real, fake]);
    expect(count('delivery_candidates')).toBe(2);
  });

  it('writes 3,000 candidates in two statements, not one a row, each row as given', () => {
    const base = event().candidates[0]!;
    const candidates = Array.from({ length: 3000 }, (_, i) => ({
      ...base,
      memoryId: `m${i}`,
      rank: i + 1,
      score: i / 7,
      tokens: i,
    }));
    const { result, statements } = recordStatements(() => writeDeliveryEventOnHandle(db, event({ candidates })));
    expect(countMatching(statements, 'INSERT INTO delivery_candidates')).toBe(2);
    const rows = db
      .prepare(
        'SELECT memory_id, cand_rank, score, tokens FROM delivery_candidates WHERE event_id = ? ORDER BY cand_rank',
      )
      .all(result);
    expect(rows).toEqual(
      candidates.map((c) => ({
        memory_id: c.memoryId,
        cand_rank: c.rank,
        score: c.score,
        tokens: c.tokens,
      })),
    );
  });

  it('rolls back and returns null with one stderr line when a write fails', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    db.exec('DROP TABLE delivery_candidates');
    expect(writeDeliveryEventOnHandle(db, event())).toBeNull();
    expect(count('delivery_events')).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] error: delivery ledger write failed: /);
  });

  it('names the request on the failure line when the write runs inside one', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    db.exec('DROP TABLE delivery_candidates');
    expect(runWithRequestId('req-ledger-7', () => writeDeliveryEventOnHandle(db, event()))).toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(
      /^\[hippo\] error: delivery ledger write failed: .* requestId=req-ledger-7 errorClass=\w+ stack=.*\n$/,
    );
  });
});

describe('the delivery ledger prune', () => {
  const prunes = (log: StatementLog<number | null>): number =>
    countMatching(log.statements, /^DELETE FROM delivery_events/);
  const writeVia = (ledger: ReturnType<typeof sqliteSyncStore>['ledger'], promptHash: string, ms: number) =>
    recordStatements(() => ledger.writeDeliveryEvent(event({ promptHash, ts: at(ms) })));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs at most once a minute per store, and again once the store's minute has passed", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-09-01T00:00:00.000Z'));
    const { ledger } = sqliteSyncStore(handlesOf(root));
    expect([writeVia(ledger, 'p1', 0), writeVia(ledger, 'p2', 30_000)].map(prunes)).toEqual([1, 0]);
    vi.setSystemTime(Date.parse('2026-09-01T00:00:59.000Z'));
    expect(prunes(writeVia(ledger, 'p3', 59_000))).toBe(0);
    vi.setSystemTime(Date.parse('2026-09-01T00:01:01.000Z'));
    expect(prunes(writeVia(ledger, 'p4', 61_000))).toBe(1);
    expect(prunes(writeVia(sqliteSyncStore(handlesOf(root)).ledger, 'another store', 62_000))).toBe(1);
    expect(count('delivery_events')).toBe(5);
  });

  it('leaves the next write due when the write that would have pruned fails', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const prune = deliveryPruneSchedule();
    db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON delivery_candidates BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    expect(writeDeliveryEventOnHandle(db, event(), prune)).toBeNull();
    db.exec('DROP TRIGGER refuse');
    expect(prunes(recordStatements(() => writeDeliveryEventOnHandle(db, event({ ts: at(1000) }), prune)))).toBe(1);
  });
});

describe('writeDeliveryEventAtRoot under a held write lock', () => {
  it('drops the row fast, then numbers the next written turn after the last recorded one', () => {
    const prune = deliveryPruneSchedule();
    expect(writeDeliveryEventVia(handlesOf(root).on, event({ promptHash: 'p1' }), prune)).not.toBeNull();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const holder = openHippoDb(root);
    holder.exec('BEGIN IMMEDIATE');
    let dropped: StatementLog<number | null>;
    try {
      dropped = recordStatements(() =>
        writeDeliveryEventVia(handlesOf(root).on, event({ promptHash: 'p2', ts: at(5000) }), prune),
      );
    } finally {
      holder.exec('COMMIT');
      closeHippoDb(holder);
    }
    expect(dropped.result).toBeNull();
    expectOneShortWait(dropped.statements);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] error: delivery ledger write failed: /);
    const next = writeDeliveryEventVia(handlesOf(root).on, event({ promptHash: 'p3', ts: at(10_000) }), prune);
    expect(next).not.toBeNull();
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.turn_seq)).toEqual([1, 2]);
  });

  it("on a caller's handle, waits only the ledger's short wait, then gives the handle its 5 s wait back", () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const holder = openHippoDb(root);
    holder.exec('BEGIN IMMEDIATE');
    let dropped: StatementLog<number | null>;
    try {
      dropped = recordStatements(() => writeDeliveryEventOnHandle(db, event()));
    } finally {
      holder.exec('COMMIT');
      closeHippoDb(holder);
    }
    expect(dropped.result).toBeNull();
    expectOneShortWait(dropped.statements);
    expect(err).toHaveBeenCalledTimes(1);
    // SAFETY: PRAGMA busy_timeout returns one row with one `timeout` column.
    expect((db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(5000);
    expect(writeDeliveryEventOnHandle(db, event())).not.toBeNull();
  });

  it("restores the handle's own lock wait, not a fixed default", () => {
    const own = openHippoDb(root, { busyWaitMs: 1234 });
    try {
      expect(writeDeliveryEventOnHandle(own, event())).not.toBeNull();
      expect((own.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout).toBe(1234);
    } finally {
      closeHippoDb(own);
    }
  });
});

describe('createDeliveryRecorder row building', () => {
  const mem = (n: number, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
    ...createMemory(`memory number ${n}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }),
    id: `m${String(n).padStart(3, '0')}`,
    ...extra,
  });
  const recorder = (payload: Record<string, string> = {}) =>
    createDeliveryRecorder({
      ledger: sqliteStore(root).ledger,
      storeHash: 'aaaaaaaaaaaaaaaa',
      writeStore: 'local',
      tenantId: 'default',
      stdinText: JSON.stringify({
        session_id: 's',
        prompt: 'the raw prompt text',
        hook_event_name: 'UserPromptSubmit',
        ...payload,
      }),
    });
  const built = (rec: ReturnType<typeof recorder>): DeliveryEventInput => {
    const input = rec.takeEvent();
    if (input === null) throw new Error('recorder built nothing');
    return input;
  };

  it('caps rejected rows deepest stage first, keeps every selected row, and counts the rest', () => {
    const rec = recorder();
    const entries = Array.from({ length: 40 }, (_, i) => mem(i));
    rec.offer(entries, false);
    const stages: Array<[DeliveryStage, DeliveryRejectReason]> = [
      ['load', 'duplicate'],
      ['gate', 'gate-below-threshold'],
      ['budget', 'budget'],
    ];
    entries.slice(2, 32).forEach((e, i) => {
      const [stage, reason] = stages[i % 3];
      rec.reject(e, stage, reason, i);
    });
    rec.selected([
      { entry: entries[0], score: 2, tokens: 5 },
      { entry: entries[1], score: 1, tokens: 7 },
    ]);
    rec.delivered({ state: 'sent', emittedText: 'block text' });
    const input = built(rec);
    const rejectedRows = input.candidates.filter((c) => c.outcome === 'rejected');
    expect(input.candidates.filter((c) => c.outcome === 'emitted').map((c) => [c.memoryId, c.rank])).toEqual([
      ['m000', 1],
      ['m001', 2],
    ]);
    expect(rejectedRows).toHaveLength(DELIVERY_REJECTED_ROW_CAP);
    expect(rejectedRows.slice(0, 10).every((c) => c.stage === 'budget')).toBe(true);
    expect(rejectedRows.slice(10).every((c) => c.stage === 'gate')).toBe(true);
    expect(rejectedRows[0].score).toBeGreaterThan(rejectedRows[1].score ?? 0);
    // 30 rejected (16 listed) + 8 never decided = 38 rejected, 22 unlisted.
    expect([input.consideredCount, input.selectedCount, input.rejectedCount, input.rejectedUnlisted]).toEqual([
      40, 2, 38, 22,
    ]);
    expect([input.selectedTokens, input.emittedCount]).toEqual([12, 2]);
  });

  it('keeps the first rejection, lets selection override any rejection, and marks a skipped static block reused', () => {
    const rec = recorder();
    const [a, b, c] = [mem(1, { pinned: true }), mem(2), mem(3)];
    rec.offer([a, b, c], false);
    rec.reject(b, 'eligible', 'quality');
    rec.reject(b, 'budget', 'budget');
    rec.reject(a, 'budget', 'budget');
    rec.selected([
      { entry: a, score: 1, tokens: 3 },
      { entry: c, score: 1, tokens: 3, promptRecall: true },
    ]);
    rec.delivered({ state: 'reused-recall-sent', staticReused: true, emittedText: 'recall only' });
    const rows = new Map(built(rec).candidates.map((r) => [r.memoryId, r]));
    expect([rows.get('m001')?.outcome, rows.get('m001')?.pool]).toEqual(['reused', 'pin']);
    expect([rows.get('m002')?.stage, rows.get('m002')?.reason]).toEqual(['eligible', 'quality']);
    expect([rows.get('m003')?.outcome, rows.get('m003')?.pool]).toEqual(['emitted', 'prompt-recall']);
  });

  it('hashes the prompt and the emitted text, never storing either', () => {
    const rec = recorder();
    rec.delivered({ state: 'sent', emittedText: 'block text' });
    const input = built(rec);
    expect(input.promptHash).toMatch(/^[0-9a-f]{16}$/);
    expect(input.emittedHash).toMatch(/^[0-9a-f]{16}$/);
    expect([input.promptLength, input.injectedTokens, input.runtime, input.eventType]).toEqual([
      19,
      3,
      'claude-code',
      'prompt-submit',
    ]);
    expect(JSON.stringify(input)).not.toContain('raw prompt');
  });

  it('a selected row names the store of the copy that was kept, not the one first offered', () => {
    const rec = recorder();
    const synced = mem(1);
    rec.offer([synced], false);
    rec.offer([synced], true);
    rec.selected([{ entry: synced, score: 1, tokens: 3, isGlobal: true }]);
    expect(built(rec).candidates.map((c) => [c.memoryId, c.sourceStore])).toEqual([['m001', 'global']]);
  });

  it('disabled beats the renderer reporting an empty block', () => {
    const rec = recorder();
    rec.disabled();
    rec.delivered({ state: 'empty' });
    expect(built(rec).blockState).toBe('disabled');
  });

  it('hands its event out once, so the fallback flush after a turn carried it writes nothing', () => {
    const rec = recorder();
    expect(rec.takeEvent()).not.toBeNull();
    expect(rec.takeEvent()).toBeNull();
  });
});

describe('tool-failure rows', () => {
  const failureEvent = (overrides: Partial<DeliveryEventInput> = {}): DeliveryEventInput =>
    event({
      eventType: 'tool-failure',
      promptHash: null,
      promptLength: 0,
      blockState: 'empty',
      consideredCount: 0,
      selectedCount: 0,
      emittedCount: 0,
      selectedTokens: 0,
      injectedTokens: 0,
      budgetTokens: 0,
      staticHash: null,
      emittedHash: null,
      elapsedMs: 1,
      toolUseId: null,
      failureId: null,
      candidates: [],
      ...overrides,
    });
  const rows = () => readDeliveryEvents(db, 'default', 'sess-1');

  it('every stored row carries the current ledger version', () => {
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1', failureId: 3 }));
    const [row] = rows();
    expect([row.ledger_version, row.tool_use_id, row.failure_id]).toEqual([DELIVERY_LEDGER_VERSION, 'toolu_1', 3]);
    expect(DELIVERY_LEDGER_VERSION).toBe(4);
  });

  it('the same tool_use_id twice is a duplicate of the first row and unnumbered', () => {
    const first = writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    const second = writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    expect(rows().map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [second, null, first],
    ]);
  });

  it('two distinct ids within one millisecond are two numbered rows', () => {
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_2' }));
    expect(rows().map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it('no id gives two numbered rows, never merged by time', () => {
    writeDeliveryEventOnHandle(db, failureEvent());
    writeDeliveryEventOnHandle(db, failureEvent());
    expect(rows().map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
      [1, null],
      [2, null],
    ]);
  });

  it('the same id in another session or tenant is not a duplicate', () => {
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1', sessionId: 'sess-2' }));
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1', tenantId: 'other' }));
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null]]);
    expect(readDeliveryEvents(db, 'other', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null]]);
  });

  it('a sub-agent row is unnumbered and never a duplicate', () => {
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1', sessionState: 'subagent' }));
    expect(rows().map((r) => [r.session_state, r.turn_seq, r.duplicate_of])).toEqual([
      ['payload', 1, null],
      ['subagent', null, null],
    ]);
  });

  it('the index rejects a forced second numbered row with the same key', () => {
    writeDeliveryEventOnHandle(db, failureEvent({ toolUseId: 'toolu_1' }));
    const forced = (turnSeq: number | null): void => {
      db.prepare(
        `INSERT INTO delivery_events (ts, ledger_version, tenant_id, runtime, event_type, surface, store_hash, write_store, session_id,
         session_state, turn_seq, block_state, tool_use_id)
       VALUES ('2026-09-01T00:00:00.000Z', 4, 'default', 'claude-code', 'tool-failure', 'hook', 'aaaaaaaaaaaaaaaa', 'local', 'sess-1',
         'payload', ?, 'empty', 'toolu_1')`,
      ).run(turnSeq);
    };
    expect(() => forced(9)).toThrow(/UNIQUE|constraint/i);
    expect(() => forced(null)).not.toThrow();
  });
});
