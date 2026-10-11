// The recorder and writer halves of `tool-failure` rows (src/store/delivery-recorder.ts, src/store/recall-trace.ts), on a real SQLite store.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { readDeliveryEvents, writeDeliveryEvent } from '../src/store/recall-trace.js';
import {
  createDeliveryRecorder,
  DELIVERY_LEDGER_VERSION,
  _setDeliveryFaultForTests,
  type DeliveryEventInput,
  type DeliveryEventType,
} from '../src/store/delivery-recorder.js';

let root: string;
let db: DatabaseSyncLike;

function failureEvent(overrides: Partial<DeliveryEventInput> = {}): DeliveryEventInput {
  return {
    ts: '2026-09-01T00:00:00.000Z', tenantId: 'default', runtime: 'claude-code', eventType: 'tool-failure', surface: 'hook',
    storeHash: 'aaaaaaaaaaaaaaaa', writeStore: 'local', projectHash: null, sessionId: 'sess-1', sessionState: 'payload',
    hostTurnId: null, promptHash: null, promptLength: 0, queryHash: null, recallTraceId: null, blockState: 'empty',
    promptRecall: false, consideredCount: 0, filteredCount: 0, selectedCount: 0, emittedCount: 0, rejectedCount: 0,
    rejectedUnlisted: 0, sectionsShown: 0, sectionsDropped: 0, budgetTokens: 0, selectedTokens: 0, injectedTokens: 0,
    staticHash: null, recallHash: null, emittedHash: null, elapsedMs: 1, toolUseId: null, failureId: null, candidates: [],
    ...overrides,
  };
}

function recorder(eventType: DeliveryEventType, payload: Record<string, string>) {
  return createDeliveryRecorder({
    root, storeHash: 'aaaaaaaaaaaaaaaa', writeStore: 'local', tenantId: 'default', eventType,
    stdinText: JSON.stringify({ session_id: 's', hook_event_name: 'PostToolUseFailure', ...payload }),
  });
}

function built(rec: ReturnType<typeof recorder>): DeliveryEventInput {
  let input: DeliveryEventInput | null = null;
  rec.flush((i) => { input = i; return 1; });
  if (input === null) throw new Error('recorder wrote nothing');
  return input;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-delivery-toolfail-'));
  db = openHippoDb(root);
});

afterEach(() => {
  _setDeliveryFaultForTests(null);
  vi.restoreAllMocks();
  closeHippoDb(db);
  fs.rmSync(root, { recursive: true, force: true });
});

describe('tool-failure recorder', () => {
  it('reads tool_use_id trimmed and cut to 128 characters, and a blank one as null', () => {
    expect(built(recorder('tool-failure', { tool_use_id: '  toolu_1  ' })).toolUseId).toBe('toolu_1');
    expect(built(recorder('tool-failure', { tool_use_id: 'x'.repeat(300) })).toolUseId).toBe('x'.repeat(128));
    expect(built(recorder('tool-failure', { tool_use_id: '   ' })).toolUseId).toBeNull();
    expect(built(recorder('tool-failure', {})).toolUseId).toBeNull();
  });

  it('sets the tool call and failure link on tool-failure rows only, with no candidates or counts', () => {
    const rec = recorder('tool-failure', { tool_use_id: 'toolu_1' });
    rec.logged(42);
    const input = built(rec);
    expect([input.eventType, input.surface, input.blockState, input.toolUseId, input.failureId]).toEqual(['tool-failure', 'hook', 'empty', 'toolu_1', 42]);
    expect([input.candidates, input.consideredCount, input.emittedCount, input.promptHash, input.promptLength]).toEqual([[], 0, 0, null, 0]);
    const other = recorder('prompt-submit', { tool_use_id: 'toolu_1', prompt: 'hello' });
    other.logged(42);
    const o = built(other);
    expect([o.toolUseId, o.failureId]).toEqual([null, null]);
  });

  it('logged(null) leaves the link empty', () => {
    const rec = recorder('tool-failure', {});
    rec.logged(null);
    expect(built(rec).failureId).toBeNull();
  });

  it('a throw inside logged marks the recorder broken, so it writes nothing', () => {
    _setDeliveryFaultForTests('observe');
    const rec = recorder('tool-failure', { tool_use_id: 'toolu_1' });
    rec.logged(7);
    const write = vi.fn(() => 1);
    rec.flush(write);
    expect(write).not.toHaveBeenCalled();
  });

  it('every stored row carries the current ledger version', () => {
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1', failureId: 3 }));
    const [row] = readDeliveryEvents(db, 'default', 'sess-1');
    expect([row.ledger_version, row.tool_use_id, row.failure_id]).toEqual([DELIVERY_LEDGER_VERSION, 'toolu_1', 3]);
    expect(DELIVERY_LEDGER_VERSION).toBe(4);
  });
});

describe('tool-failure writer', () => {
  const rows = () => readDeliveryEvents(db, 'default', 'sess-1');

  it('the same tool_use_id twice is a duplicate of the first row and unnumbered', () => {
    const first = writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    const second = writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    expect(rows().map((r) => [r.id, r.turn_seq, r.duplicate_of])).toEqual([[first, 1, null], [second, null, first]]);
  });

  it('two distinct ids within one millisecond are two numbered rows', () => {
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_2' }));
    expect(rows().map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null], [2, null]]);
  });

  it('no id gives two numbered rows, never merged by time', () => {
    writeDeliveryEvent(db, failureEvent());
    writeDeliveryEvent(db, failureEvent());
    expect(rows().map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null], [2, null]]);
  });

  it('the same id in another session or tenant is not a duplicate', () => {
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1', sessionId: 'sess-2' }));
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1', tenantId: 'other' }));
    expect(readDeliveryEvents(db, 'default', 'sess-2').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null]]);
    expect(readDeliveryEvents(db, 'other', 'sess-1').map((r) => [r.turn_seq, r.duplicate_of])).toEqual([[1, null]]);
  });

  it('a sub-agent row is unnumbered and never a duplicate', () => {
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1', sessionState: 'subagent' }));
    expect(rows().map((r) => [r.session_state, r.turn_seq, r.duplicate_of])).toEqual([['payload', 1, null], ['subagent', null, null]]);
  });

  it('the index rejects a forced second numbered row with the same key', () => {
    writeDeliveryEvent(db, failureEvent({ toolUseId: 'toolu_1' }));
    const forced = (turnSeq: number | null): void => { db.prepare(
      `INSERT INTO delivery_events (ts, ledger_version, tenant_id, runtime, event_type, surface, store_hash, write_store, session_id,
         session_state, turn_seq, block_state, tool_use_id)
       VALUES ('2026-09-01T00:00:00.000Z', 4, 'default', 'claude-code', 'tool-failure', 'hook', 'aaaaaaaaaaaaaaaa', 'local', 'sess-1',
         'payload', ?, 'empty', 'toolu_1')`,
    ).run(turnSeq); };
    expect(() => forced(9)).toThrow(/UNIQUE|constraint/i);
    expect(() => forced(null)).not.toThrow();
  });
});
