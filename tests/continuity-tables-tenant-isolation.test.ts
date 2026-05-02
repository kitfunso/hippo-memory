import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  appendSessionEvent,
  listSessionEvents,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  findPromotableSessions,
} from '../src/store.js';

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-continuity-iso-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('session_events tenant isolation', () => {
  it('listSessionEvents does not return rows from another tenant', () => {
    initStore(tmpDir);

    appendSessionEvent(tmpDir, 'tenantA', {
      session_id: 'shared-id',
      event_type: 'note',
      content: 'A says hi',
      source: 'test',
    });
    appendSessionEvent(tmpDir, 'tenantB', {
      session_id: 'shared-id',
      event_type: 'note',
      content: 'B says hi',
      source: 'test',
    });

    const aEvents = listSessionEvents(tmpDir, 'tenantA', { session_id: 'shared-id' });
    const bEvents = listSessionEvents(tmpDir, 'tenantB', { session_id: 'shared-id' });

    expect(aEvents).toHaveLength(1);
    expect(aEvents[0].content).toBe('A says hi');
    expect(bEvents).toHaveLength(1);
    expect(bEvents[0].content).toBe('B says hi');
  });

  it('findPromotableSessions only sees the calling tenant', () => {
    initStore(tmpDir);

    appendSessionEvent(tmpDir, 'tenantA', {
      session_id: 'sess-a',
      event_type: 'session_complete',
      content: 'success',
      source: 'test',
    });
    appendSessionEvent(tmpDir, 'tenantB', {
      session_id: 'sess-b',
      event_type: 'session_complete',
      content: 'success',
      source: 'test',
    });

    const aPromotable = findPromotableSessions(tmpDir, 'tenantA', Date.now() - 60_000);
    const bPromotable = findPromotableSessions(tmpDir, 'tenantB', Date.now() - 60_000);

    expect(aPromotable.map((p) => p.session_id)).toEqual(['sess-a']);
    expect(bPromotable.map((p) => p.session_id)).toEqual(['sess-b']);
  });
});

describe('session_handoffs tenant isolation', () => {
  it('loadLatestHandoff (no sessionId) does not surface another tenant row', () => {
    initStore(tmpDir);

    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'sess-a',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });

    expect(loadLatestHandoff(tmpDir, 'tenantA')).not.toBeNull();
    expect(loadLatestHandoff(tmpDir, 'tenantB')).toBeNull();
  });

  it('loadLatestHandoff with same session_id returns each tenant own handoff', () => {
    initStore(tmpDir);

    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'shared',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });
    saveSessionHandoff(tmpDir, 'tenantB', {
      version: 1,
      sessionId: 'shared',
      summary: 'B handoff',
      nextAction: 'B action',
      artifacts: [],
    });

    const a = loadLatestHandoff(tmpDir, 'tenantA', 'shared');
    const b = loadLatestHandoff(tmpDir, 'tenantB', 'shared');

    expect(a!.summary).toBe('A handoff');
    expect(b!.summary).toBe('B handoff');
  });

  it('loadHandoffById rejects cross-tenant lookups', async () => {
    initStore(tmpDir);

    saveSessionHandoff(tmpDir, 'tenantA', {
      version: 1,
      sessionId: 'sess-a',
      summary: 'A handoff',
      nextAction: 'A action',
      artifacts: [],
    });

    const { openHippoDb, closeHippoDb } = await import('../src/db.js');
    const db = openHippoDb(tmpDir);
    let id: number;
    try {
      const row = db.prepare(`SELECT id FROM session_handoffs WHERE session_id='sess-a'`).get() as { id: number };
      id = row.id;
    } finally {
      closeHippoDb(db);
    }

    expect(loadHandoffById(tmpDir, 'tenantA', id)).not.toBeNull();
    expect(loadHandoffById(tmpDir, 'tenantB', id)).toBeNull();
  });
});

describe('runtime guards', () => {
  it('throws clear error when tenantId is empty string', () => {
    initStore(tmpDir);
    expect(() => listSessionEvents(tmpDir, '', { session_id: 'x' })).toThrow(/tenantId is required/);
    expect(() => loadLatestHandoff(tmpDir, '', 'x')).toThrow(/tenantId is required/);
  });

  it('rejects misbinding: passing a session_id where tenantId is expected', () => {
    initStore(tmpDir);
    // A JS caller from a v0.40 codebase that called loadLatestHandoff(root, sessionId)
    // would now have 'sess-abc' bound to tenantId. The runtime guard catches this
    // before it silently filters to a non-existent tenant.
    expect(() => loadLatestHandoff(tmpDir, 'sess-abc' as never)).toThrow(/looks like a session id/i);
    expect(() => listSessionEvents(tmpDir, 'sess_xyz' as never, { session_id: 'x' })).toThrow(/looks like a session id/i);
    expect(() => saveSessionHandoff(tmpDir, 'SESS-uppercase' as never, {
      version: 1, sessionId: 's', summary: 'x', artifacts: [],
    })).toThrow(/looks like a session id/i);
  });

  it('rejects non-string tenantId values', () => {
    initStore(tmpDir);
    expect(() => loadLatestHandoff(tmpDir, undefined as never, 'x')).toThrow(/tenantId is required/);
    expect(() => loadLatestHandoff(tmpDir, null as never, 'x')).toThrow(/tenantId is required/);
    expect(() => loadLatestHandoff(tmpDir, 42 as never, 'x')).toThrow(/tenantId is required/);
  });
});
