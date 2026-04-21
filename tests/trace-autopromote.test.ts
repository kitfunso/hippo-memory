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
  it('promotes a session with a session_complete event into a trace', () => {
    initStore(tmpDir);
    const sid = 'test-session-auto';
    appendSessionEvent(tmpDir, {
      session_id: sid, event_type: 'action', content: 'read x.ts', source: 'agent',
    });
    appendSessionEvent(tmpDir, {
      session_id: sid, event_type: 'action', content: 'edit line 42', source: 'agent',
    });
    appendSessionEvent(tmpDir, {
      session_id: sid,
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
      metadata: { summary: 'fixed broken test' },
    });

    consolidate(tmpDir, { now: new Date() });

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

  it('does NOT promote sessions that lack a session_complete event', () => {
    initStore(tmpDir);
    const sid = 'test-no-outcome';
    appendSessionEvent(tmpDir, {
      session_id: sid, event_type: 'action', content: 'did stuff', source: 'agent',
    });

    consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });

  it('does NOT create duplicate traces across repeated sleep runs', () => {
    initStore(tmpDir);
    const sid = 'test-idempotent';
    appendSessionEvent(tmpDir, {
      session_id: sid, event_type: 'action', content: 'action a', source: 'agent',
    });
    appendSessionEvent(tmpDir, {
      session_id: sid,
      event_type: 'session_complete',
      content: 'success',
      source: 'agent',
    });

    consolidate(tmpDir, { now: new Date() });
    consolidate(tmpDir, { now: new Date() });
    consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter(
      (e) => e.layer === Layer.Trace && e.source_session_id === sid,
    );
    expect(traces).toHaveLength(1);
  });

  it('skips sessions older than autoTraceWindowDays (default 7)', () => {
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

    consolidate(tmpDir, { now: new Date() });

    const traces = loadAllEntries(tmpDir).filter((e) => e.layer === Layer.Trace);
    expect(traces).toHaveLength(0);
  });
});
