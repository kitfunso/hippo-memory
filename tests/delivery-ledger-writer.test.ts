// The delivery ledger writer (src/store/recall-trace.ts) and the recorder's row building, on a real SQLite store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db.js';
import {
  readDeliveryEvents,
  writeDeliveryEvent,
  writeDeliveryEventAtRoot,
  writeDeliveryEventOnHandle,
  DELIVERY_LEDGER_RETENTION_DAYS,
} from '../src/store/recall-trace.js';
import {
  createDeliveryRecorder,
  DELIVERY_REJECTED_ROW_CAP,
  type DeliveryEventInput,
  type DeliveryRejectReason,
  type DeliveryStage,
} from '../src/delivery-recorder.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';
import { countMatching, recordStatements, type StatementLog } from './_helpers/count-statements.js';

// A prompt hook waits a second for a lock in all; the ledger may spend a fraction of it.
const MAX_LEDGER_WAIT_MS = 100;

/** One write attempt, made under a short lock wait: a bounded delay on any runner, which elapsed time is not. */
function expectOneShortWait(statements: readonly string[]): void {
  expect(countMatching(statements, /^BEGIN IMMEDIATE$/)).toBe(1);
  const waitsSet = statements.slice(0, statements.indexOf('BEGIN IMMEDIATE')).filter((sql) => sql.startsWith('PRAGMA busy_timeout = '));
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
    candidates: [{
      memoryId: 'mem-1', sourceStore: 'local', pool: 'pin', stage: 'final', outcome: 'emitted',
      reason: null, rank: 1, score: 1, tokens: 10,
    }],
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-delivery-writer-'));
  db = openHippoDb(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeHippoDb(db);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeDeliveryEvent', () => {
  it('writes the event and its candidates, and numbers turns per session', () => {
    const first = writeDeliveryEvent(db, event({ promptHash: 'p1' }));
    const second = writeDeliveryEvent(db, event({ promptHash: 'p2', ts: at(5000) }));
    const other = writeDeliveryEvent(db, event({ promptHash: 'p1', sessionId: 'sess-2' }));
    expect(first).not.toBeNull();
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of, r.ledger_version])).toEqual([
      [first, 1, null, 2],
      [second, 2, null, 2],
    ]);
    expect(rows[0].candidates).toEqual([{
      event_id: first, tenant_id: 'default', memory_id: 'mem-1', source_store: 'local', pool: 'pin', stage: 'final',
      outcome: 'emitted', reason: null, cand_rank: 1, score: 1, tokens: 10,
    }]);
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.id, r.turn_seq])).toEqual([[other, 1]]);
  });

  it('flags a repeated host turn id as a duplicate of the first, and a new turn id as a new turn', () => {
    const first = writeDeliveryEvent(db, event({ runtime: 'codex', hostTurnId: 'turn-a' }));
    const repeat = writeDeliveryEvent(db, event({ runtime: 'codex', hostTurnId: 'turn-a', ts: at(60_000) }));
    const next = writeDeliveryEvent(db, event({ runtime: 'codex', hostTurnId: 'turn-b', ts: at(500) }));
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [repeat, null, first],
      [next, 2, null],
    ]);
  });

  it('without a turn id, flags the same prompt within the window either side, never past it', () => {
    const first = writeDeliveryEvent(db, event({ ts: at(10_000) }));
    const before = writeDeliveryEvent(db, event({ ts: at(8_500) }));
    const after = writeDeliveryEvent(db, event({ ts: at(12_000) }));
    const far = writeDeliveryEvent(db, event({ ts: at(20_000) }));
    const rows = readDeliveryEvents(db, 'default', 'sess-1');
    expect(rows.map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [before, null, first],
      [after, null, first],
      [far, 2, null],
    ]);
  });

  it('gives no turn number and no duplicate check to missing-session and sub-agent events', () => {
    writeDeliveryEvent(db, event({ sessionId: null, sessionState: 'missing' }));
    writeDeliveryEvent(db, event({ sessionId: null, sessionState: 'missing' }));
    const parent = writeDeliveryEvent(db, event());
    writeDeliveryEvent(db, event({ sessionState: 'subagent' }));
    const missing = readDeliveryEvents(db, 'default', null);
    expect(missing.map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[null, null], [null, null]]);
    const inSession = readDeliveryEvents(db, 'default', 'sess-1');
    expect(inSession.map((r) => [r.id === parent, r.session_state, r.turn_seq, r.duplicate_of])).toEqual([
      [true, 'payload', 1, null],
      [false, 'subagent', null, null],
    ]);
  });

  const boundary = (eventType: 'pre-compact' | 'compact-resume', overrides: Partial<DeliveryEventInput> = {}): DeliveryEventInput =>
    event({ eventType, promptHash: null, promptLength: 0, ...overrides });

  describe.each(['pre-compact', 'compact-resume'] as const)('%s boundary duplicates', (type) => {
    it('W1 flags a second prompt-less event 500 ms later as a duplicate of the first', () => {
      const first = writeDeliveryEvent(db, boundary(type));
      const second = writeDeliveryEvent(db, boundary(type, { ts: at(500) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
        [first, 1, null],
        [second, null, first],
      ]);
    });

    it('W2 numbers the same pair 3000 ms apart as turns 1 and 2', () => {
      writeDeliveryEvent(db, boundary(type));
      writeDeliveryEvent(db, boundary(type, { ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null], [2, null]]);
    });

    it('W6 with one host turn id, flags 500 ms apart and numbers 3000 ms apart', () => {
      const first = writeDeliveryEvent(db, boundary(type, { hostTurnId: 'turn-a' }));
      const near = writeDeliveryEvent(db, boundary(type, { hostTurnId: 'turn-a', ts: at(500) }));
      const far = writeDeliveryEvent(db, boundary(type, { hostTurnId: 'turn-a', ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
        [first, 1, null],
        [near, null, first],
        [far, 2, null],
      ]);
    });

    it('W7 measures the window from the numbered row, so a third fire 1500 ms after a duplicate is numbered', () => {
      const first = writeDeliveryEvent(db, boundary(type));
      writeDeliveryEvent(db, boundary(type, { ts: at(1500) }));
      writeDeliveryEvent(db, boundary(type, { ts: at(3000) }));
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([
        [1, null], [null, first], [2, null],
      ]);
    });

    it('W5 gives a missing-session or sub-agent boundary no number and no duplicate', () => {
      writeDeliveryEvent(db, boundary(type, { sessionId: null, sessionState: 'missing' }));
      writeDeliveryEvent(db, boundary(type, { sessionId: null, sessionState: 'missing', ts: at(500) }));
      writeDeliveryEvent(db, boundary(type, { sessionState: 'subagent' }));
      writeDeliveryEvent(db, boundary(type, { sessionState: 'subagent', ts: at(500) }));
      expect(readDeliveryEvents(db, 'default', null).map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[null, null], [null, null]]);
      expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.session_state, r.turn_seq, r.duplicate_of])).toEqual([
        ['subagent', null, null], ['subagent', null, null],
      ]);
    });
  });

  it('W3 keeps numbering a prompt-less prompt-submit pair 500 ms apart', () => {
    writeDeliveryEvent(db, event({ promptHash: null, promptLength: 0 }));
    writeDeliveryEvent(db, event({ promptHash: null, promptLength: 0, ts: at(500) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null], [2, null]]);
  });

  it('W6 still flags a prompt-submit pair with one turn id 3000 ms apart', () => {
    const first = writeDeliveryEvent(db, event({ hostTurnId: 'turn-a' }));
    const repeat = writeDeliveryEvent(db, event({ hostTurnId: 'turn-a', ts: at(3000) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([
      [first, 1, null],
      [repeat, null, first],
    ]);
  });

  it('W4 numbers each event type on its own, and never matches another session', () => {
    writeDeliveryEvent(db, event({ promptHash: 'p1' }));
    writeDeliveryEvent(db, boundary('pre-compact', { ts: at(100) }));
    writeDeliveryEvent(db, boundary('compact-resume', { ts: at(200) }));
    writeDeliveryEvent(db, boundary('pre-compact', { sessionId: 'sess-2', ts: at(300) }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => [r.event_type, r.turn_seq, r.duplicate_of])).toEqual([
      ['prompt-submit', 1, null], ['pre-compact', 1, null], ['compact-resume', 1, null],
    ]);
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.event_type, r.turn_seq, r.duplicate_of])).toEqual([
      ['pre-compact', 1, null],
    ]);
  });

  it('prunes events past the retention window, with their candidates', () => {
    writeDeliveryEvent(db, event({ ts: '2026-01-01T00:00:00.000Z', promptHash: 'old' }));
    expect(count('delivery_candidates')).toBe(1);
    const later = new Date(Date.parse('2026-01-01T00:00:00.000Z') + (DELIVERY_LEDGER_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const kept = writeDeliveryEvent(db, event({ ts: later, promptHash: 'new' }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.id)).toEqual([kept]);
    expect(count('delivery_candidates')).toBe(1);
  });

  it('a write under a far-future fake time prunes no real rows', () => {
    const real = writeDeliveryEvent(db, event({ ts: new Date().toISOString(), promptHash: 'real' }));
    const fake = writeDeliveryEvent(db, event({ ts: '2099-01-01T00:00:00.000Z', promptHash: 'fake' }));
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.id)).toEqual([real, fake]);
    expect(count('delivery_candidates')).toBe(2);
  });

  it('rolls back and returns null with one stderr line when a write fails', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    db.exec('DROP TABLE delivery_candidates');
    expect(writeDeliveryEvent(db, event())).toBeNull();
    expect(count('delivery_events')).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] delivery ledger write failed: /);
  });
});

describe('writeDeliveryEventAtRoot under a held write lock', () => {
  it('drops the row fast, then numbers the next written turn after the last recorded one', () => {
    expect(writeDeliveryEventAtRoot(root, event({ promptHash: 'p1' }))).not.toBeNull();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const holder = openHippoDb(root);
    holder.exec('BEGIN IMMEDIATE');
    let dropped: StatementLog<number | null>;
    try {
      dropped = recordStatements(() => writeDeliveryEventAtRoot(root, event({ promptHash: 'p2', ts: at(5000) })));
    } finally {
      holder.exec('COMMIT');
      closeHippoDb(holder);
    }
    expect(dropped.result).toBeNull();
    expectOneShortWait(dropped.statements);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0][0])).toMatch(/^\[hippo\] delivery ledger/);
    const next = writeDeliveryEventAtRoot(root, event({ promptHash: 'p3', ts: at(10_000) }));
    expect(next).not.toBeNull();
    expect(readDeliveryEvents(db, 'default', 'sess-1').map((r) => r.turn_seq)).toEqual([1, 2]);
  });

  it("on a caller's handle, waits only the ledger's short wait, then gives the handle its 5 s wait back", () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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
      expect(own.prepare('PRAGMA busy_timeout').get<{ timeout: number }>().timeout).toBe(1234);
    } finally {
      closeHippoDb(own);
    }
  });
});

describe('createDeliveryRecorder row building', () => {
  const mem = (n: number, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...createMemory(`memory number ${n}`, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), id: `m${String(n).padStart(3, '0')}`, ...extra });
  const recorder = (payload: Record<string, string> = {}) => createDeliveryRecorder({
    root, storeHash: 'aaaaaaaaaaaaaaaa', writeStore: 'local', tenantId: 'default',
    stdinText: JSON.stringify({ session_id: 's', prompt: 'the raw prompt text', hook_event_name: 'UserPromptSubmit', ...payload }),
  });
  const built = (rec: ReturnType<typeof recorder>): DeliveryEventInput => {
    let input: DeliveryEventInput | null = null;
    rec.flush((i) => { input = i; return 1; });
    if (input === null) throw new Error('recorder wrote nothing');
    return input;
  };

  it('caps rejected rows deepest stage first, keeps every selected row, and counts the rest', () => {
    const rec = recorder();
    const entries = Array.from({ length: 40 }, (_, i) => mem(i));
    rec.offer(entries, false);
    const stages: Array<[DeliveryStage, DeliveryRejectReason]> = [['load', 'duplicate'], ['gate', 'gate-below-threshold'], ['budget', 'budget']];
    entries.slice(2, 32).forEach((e, i) => {
      const [stage, reason] = stages[i % 3];
      rec.reject(e, stage, reason, i);
    });
    rec.selected([{ entry: entries[0], score: 2, tokens: 5 }, { entry: entries[1], score: 1, tokens: 7 }]);
    rec.delivered({ state: 'sent', emittedText: 'block text' });
    const input = built(rec);
    const rejectedRows = input.candidates.filter((c) => c.outcome === 'rejected');
    expect(input.candidates.filter((c) => c.outcome === 'emitted').map((c) => [c.memoryId, c.rank])).toEqual([['m000', 1], ['m001', 2]]);
    expect(rejectedRows).toHaveLength(DELIVERY_REJECTED_ROW_CAP);
    expect(rejectedRows.slice(0, 10).every((c) => c.stage === 'budget')).toBe(true);
    expect(rejectedRows.slice(10).every((c) => c.stage === 'gate')).toBe(true);
    expect(rejectedRows[0].score).toBeGreaterThan(rejectedRows[1].score ?? 0);
    // 30 rejected (16 listed) + 8 never decided = 38 rejected, 22 unlisted.
    expect([input.consideredCount, input.selectedCount, input.rejectedCount, input.rejectedUnlisted]).toEqual([40, 2, 38, 22]);
    expect([input.selectedTokens, input.emittedCount]).toEqual([12, 2]);
  });

  it('keeps the first rejection, lets selection override any rejection, and marks a skipped static block reused', () => {
    const rec = recorder();
    const [a, b, c] = [mem(1, { pinned: true }), mem(2), mem(3)];
    rec.offer([a, b, c], false);
    rec.reject(b, 'eligible', 'quality');
    rec.reject(b, 'budget', 'budget');
    rec.reject(a, 'budget', 'budget');
    rec.selected([{ entry: a, score: 1, tokens: 3 }, { entry: c, score: 1, tokens: 3, promptRecall: true }]);
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
    expect([input.promptLength, input.injectedTokens, input.runtime, input.eventType]).toEqual([19, 3, 'claude-code', 'prompt-submit']);
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

  it('writes once per call, so the fallback flush after a shared-handle flush writes nothing', () => {
    const rec = recorder();
    const write = vi.fn(() => 1);
    rec.flush(write);
    rec.flush(write);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
