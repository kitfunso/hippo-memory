import { describe, it, expect, beforeEach } from 'vitest';
import { consolidate } from '../../src/index.js';
import { listMemoryConflicts, loadAllEntries, appendSessionEvent } from '../_helpers/root-forms.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { Layer } from '../../src/base/memory/memory.js';
import { makeRoot } from '../_helpers/make-root.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';
import { FIXED_NOW, pinClock } from '../_helpers/fixed-clock.js';

pinClock();

oneRequestPerTest();

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeRoot('autotrace', { init: false });
});

describe('consolidate auto-promote: session -> trace', () => {
  it('promotes a session with a session_complete event into a trace', async () => {
    initTestStore(tmpDir);
    const sid = 'test-session-auto';
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'action',
      content: 'read x.ts',
      source: 'agent',
    });
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'action',
      content: 'edit line 42',
      source: 'agent',
    });
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: 'fixed broken test' },
    });

    const result = await consolidate(tmpDir, { now: FIXED_NOW });

    expect(result.promotedTraces).toBe(1);
    expect(result.details).toContain('  🧬 promoted 1 trace from completed session');
    expect(result.details.some((l) => l.includes(`from session ${sid} (success)`))).toBe(true);
    const traces = loadAllEntries(tmpDir, 'default').filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(1);
    expect(traces[0].traceOutcome).toBe('success');
    expect(traces[0].sourceSessionId).toBe(sid);
    // Provenance lives in source_session_id; parents is NOT polluted.
    expect(traces[0].parents).toEqual([]);
    expect(traces[0].tags).toContain('auto-promoted');
    expect(traces[0].content).toContain('read x.ts');
    expect(traces[0].content).toContain('edit line 42');
    expect(traces[0].content).toContain('Task: fixed broken test');
    expect(traces[0].content).toContain('Outcome: success');
  });

  it('does NOT promote sessions that lack a session_complete event', async () => {
    initTestStore(tmpDir);
    const sid = 'test-no-outcome';
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'action',
      content: 'did stuff',
      source: 'agent',
    });

    await consolidate(tmpDir, { now: FIXED_NOW });

    const traces = loadAllEntries(tmpDir, 'default').filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });

  it('does NOT promote a session whose completion outcome is not a known one', async () => {
    initTestStore(tmpDir);
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: 'sess-bogus',
      eventType: 'session_complete',
      content: 'bogus',
      source: 'agent',
    });

    const result = await consolidate(tmpDir, { now: FIXED_NOW });

    expect(result.promotedTraces).toBe(0);
    expect(loadAllEntries(tmpDir, 'default').filter((e) => e.layer === Layer.Trace)).toHaveLength(0);
  });

  it('does NOT create duplicate traces across repeated sleep runs', async () => {
    initTestStore(tmpDir);
    const sid = 'test-idempotent';
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'action',
      content: 'action a',
      source: 'agent',
    });
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: sid,
      eventType: 'session_complete',
      content: 'success',
      source: 'agent',
    });

    await consolidate(tmpDir, { now: FIXED_NOW });
    await consolidate(tmpDir, { now: FIXED_NOW });
    await consolidate(tmpDir, { now: FIXED_NOW });

    const traces = loadAllEntries(tmpDir, 'default').filter(
      (e) => e.layer === Layer.Trace && e.sourceSessionId === sid,
    );
    expect(traces).toHaveLength(1);
  });

  it('does NOT fire conflict detection between two trace-layer memories', async () => {
    initTestStore(tmpDir);

    // Two traces whose content would otherwise trip the enabled/disabled
    // polarity heuristic (distinctive shared tokens + opposing polarity).
    // Without the trace-vs-trace skip, detectConflicts would flag the pair.
    // With the skip, traces are treated as variants, not contradictions.
    const sharedTokens = 'refactor auth module rotation strategy overlapping distinctive tokens here';

    await appendSessionEvent(tmpDir, 'default', {
      sessionId: 'sess-1',
      eventType: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: `${sharedTokens} always enable new flow` },
    });
    await appendSessionEvent(tmpDir, 'default', {
      sessionId: 'sess-2',
      eventType: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: `${sharedTokens} never enable new flow disable it` },
    });

    await consolidate(tmpDir, { now: FIXED_NOW });

    const entries = loadAllEntries(tmpDir, 'default');
    const traceIds = new Set(entries.filter((e) => e.layer === Layer.Trace).map((e) => e.id));
    expect(traceIds.size).toBe(2);

    const conflicts = await listMemoryConflicts(tmpDir);
    const traceVsTrace = conflicts.filter((c) => traceIds.has(c.memoryAId) && traceIds.has(c.memoryBId));
    expect(traceVsTrace).toHaveLength(0);
  });

  it('skips sessions older than autoTraceWindowDays (default 7)', async () => {
    initTestStore(tmpDir);
    const sid = 'test-stale';

    // Poke the DB directly to backdate the session_complete row by 30 days.
    const db = openHippoDb(tmpDir);
    try {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`
        INSERT INTO session_events(session_id, task, event_type, content, source, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sid, null, 'session_complete', 'success', 'agent', '{}', old);
    } finally {
      closeHippoDb(db);
    }

    await consolidate(tmpDir, { now: FIXED_NOW });

    const traces = loadAllEntries(tmpDir, 'default').filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });
});
