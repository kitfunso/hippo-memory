import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { consolidate } from '../src/consolidate.js';
import {
  initStore,
  loadAllEntries,
  appendSessionEvent,
  listMemoryConflicts,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { Layer } from '../src/memory.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-autotrace-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('consolidate auto-promote: session -> trace', () => {
  it('promotes a session with a session_complete event into a trace', async () => {
    initStore(tmpDir);
    const sid = 'test-session-auto';
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid, event_type: 'action', content: 'read x.ts', source: 'agent',
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid, event_type: 'action', content: 'edit line 42', source: 'agent',
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid,
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: 'fixed broken test' },
    });

    await consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(1);
    expect(traces[0].trace_outcome).toBe('success');
    expect(traces[0].source_session_id).toBe(sid);
    // Provenance lives in source_session_id; parents is NOT polluted.
    expect(traces[0].parents).toEqual([]);
    expect(traces[0].tags).toContain('auto-promoted');
    expect(traces[0].content).toContain('read x.ts');
    expect(traces[0].content).toContain('edit line 42');
    expect(traces[0].content).toContain('Task: fixed broken test');
    expect(traces[0].content).toContain('Outcome: success');
  });

  it('does NOT promote sessions that lack a session_complete event', async () => {
    initStore(tmpDir);
    const sid = 'test-no-outcome';
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid, event_type: 'action', content: 'did stuff', source: 'agent',
    });

    await consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });

  it('does NOT create duplicate traces across repeated sleep runs', async () => {
    initStore(tmpDir);
    const sid = 'test-idempotent';
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid, event_type: 'action', content: 'action a', source: 'agent',
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: sid,
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
    });

    await consolidate(tmpDir, { now: new Date() });
    await consolidate(tmpDir, { now: new Date() });
    await consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter(
      (e) => e.layer === Layer.Trace && e.source_session_id === sid,
    );
    expect(traces).toHaveLength(1);
  });

  it('does NOT fire conflict detection between two trace-layer memories', async () => {
    initStore(tmpDir);

    // Two traces whose content would otherwise trip the enabled/disabled
    // polarity heuristic (distinctive shared tokens + opposing polarity).
    // Without the trace-vs-trace skip, detectConflicts would flag the pair.
    // With the skip, traces are treated as variants, not contradictions.
    const sharedTokens =
      'refactor auth module rotation strategy overlapping distinctive tokens here';

    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess-1',
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: `${sharedTokens} always enable new flow` },
    });
    appendSessionEvent(tmpDir, 'default', {
      session_id: 'sess-2',
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: `${sharedTokens} never enable new flow disable it` },
    });

    await consolidate(tmpDir, { now: new Date() });

    const entries = loadAllEntries(tmpDir);
    const traceIds = new Set(
      entries.filter((e) => e.layer === Layer.Trace).map((e) => e.id),
    );
    expect(traceIds.size).toBe(2);

    const conflicts = listMemoryConflicts(tmpDir);
    const traceVsTrace = conflicts.filter(
      (c) => traceIds.has(c.memory_a_id) && traceIds.has(c.memory_b_id),
    );
    expect(traceVsTrace).toHaveLength(0);
  });

  it('skips sessions older than autoTraceWindowDays (default 7)', async () => {
    initStore(tmpDir);
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

    await consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });
});
