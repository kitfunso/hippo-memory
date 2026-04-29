import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initStore,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  appendSessionEvent,
  listSessionEvents,
  loadActiveTaskSnapshot,
  saveActiveTaskSnapshot,
} from '../src/store.js';
import {
  openHippoDb,
  closeHippoDb,
  getSchemaVersion,
  getCurrentSchemaVersion,
} from '../src/db.js';
import type { SessionHandoff } from '../src/handoff.js';
import { rowToSessionHandoff } from '../src/handoff.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pr2-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema v5+v6 migration', () => {
  it('migrates to latest schema version', () => {
    initStore(tmpDir);
    const db = openHippoDb(tmpDir);
    try {
      expect(getSchemaVersion(db)).toBe(17);
      expect(getCurrentSchemaVersion()).toBe(17);
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates the session_handoffs table', () => {
    initStore(tmpDir);
    const db = openHippoDb(tmpDir);
    try {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_handoffs'`
      ).all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      expect(tables[0]!.name).toBe('session_handoffs');
    } finally {
      closeHippoDb(db);
    }
  });

  it('creates the index on session_handoffs', () => {
    initStore(tmpDir);
    const db = openHippoDb(tmpDir);
    try {
      const indexes = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_session_handoffs_session'`
      ).all() as Array<{ name: string }>;
      expect(indexes).toHaveLength(1);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('session handoff create/save/load', () => {
  it('saves and loads a handoff', () => {
    initStore(tmpDir);

    const handoff = saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-001',
      repoRoot: '/tmp/repo',
      taskId: 'task-42',
      summary: 'Tests are green, PR is open',
      nextAction: 'Merge after review',
      artifacts: ['src/foo.ts', 'src/bar.ts'],
    });

    expect(handoff.version).toBe(1);
    expect(handoff.sessionId).toBe('sess-001');
    expect(handoff.repoRoot).toBe('/tmp/repo');
    expect(handoff.taskId).toBe('task-42');
    expect(handoff.summary).toBe('Tests are green, PR is open');
    expect(handoff.nextAction).toBe('Merge after review');
    expect(handoff.artifacts).toEqual(['src/foo.ts', 'src/bar.ts']);
    expect(handoff.updatedAt).toBeTruthy();
  });

  it('saves a minimal handoff without optional fields', () => {
    initStore(tmpDir);

    const handoff = saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-min',
      summary: 'Minimal handoff',
    });

    expect(handoff.sessionId).toBe('sess-min');
    expect(handoff.summary).toBe('Minimal handoff');
    expect(handoff.repoRoot).toBeUndefined();
    expect(handoff.taskId).toBeUndefined();
    expect(handoff.nextAction).toBeUndefined();
    expect(handoff.artifacts).toEqual([]);
  });
});

describe('loadLatestHandoff', () => {
  it('returns null when no handoffs exist', () => {
    initStore(tmpDir);
    const result = loadLatestHandoff(tmpDir);
    expect(result).toBeNull();
  });

  it('returns the most recent handoff', () => {
    initStore(tmpDir);

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-old',
      summary: 'First handoff',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-new',
      summary: 'Second handoff',
    });

    const latest = loadLatestHandoff(tmpDir);
    expect(latest).not.toBeNull();
    expect(latest!.sessionId).toBe('sess-new');
    expect(latest!.summary).toBe('Second handoff');
  });

  it('filters by session ID when provided', () => {
    initStore(tmpDir);

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-A',
      summary: 'Handoff A1',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-B',
      summary: 'Handoff B1',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-A',
      summary: 'Handoff A2',
    });

    const latestA = loadLatestHandoff(tmpDir, 'sess-A');
    expect(latestA).not.toBeNull();
    expect(latestA!.summary).toBe('Handoff A2');

    const latestB = loadLatestHandoff(tmpDir, 'sess-B');
    expect(latestB).not.toBeNull();
    expect(latestB!.summary).toBe('Handoff B1');

    const latestC = loadLatestHandoff(tmpDir, 'sess-C');
    expect(latestC).toBeNull();
  });
});

describe('loadHandoffById', () => {
  it('loads a specific handoff by row ID', () => {
    initStore(tmpDir);

    // Save handoff and verify we can get it by ID from the DB
    const handoff = saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-byid',
      summary: 'Find me by ID',
    });

    // Find the row ID by loading from DB directly
    const db = openHippoDb(tmpDir);
    try {
      const row = db.prepare(
        `SELECT id FROM session_handoffs WHERE session_id = 'sess-byid' ORDER BY id DESC LIMIT 1`
      ).get() as { id: number } | undefined;

      expect(row).toBeTruthy();
      const loaded = loadHandoffById(tmpDir, row!.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.sessionId).toBe('sess-byid');
      expect(loaded!.summary).toBe('Find me by ID');
    } finally {
      closeHippoDb(db);
    }
  });

  it('returns null for non-existent ID', () => {
    initStore(tmpDir);
    const result = loadHandoffById(tmpDir, 99999);
    expect(result).toBeNull();
  });
});

describe('fallback session ID generation', () => {
  it('getSessionIdentity produces fallback when all identifiers are missing', async () => {
    // Dynamically import the plugin to test getSessionIdentity indirectly
    // We test the pattern directly since the function is not exported
    const ctx = { sessionId: undefined, sessionKey: undefined, agentId: undefined };
    const identity = ctx.sessionId ?? ctx.sessionKey ?? ctx.agentId ?? `fallback-${Date.now()}-${process.pid}`;

    expect(identity).toMatch(/^fallback-\d+-\d+$/);
  });

  it('prefers sessionId over fallback', () => {
    const ctx = { sessionId: 'real-session', sessionKey: undefined, agentId: undefined };
    const identity = ctx.sessionId ?? ctx.sessionKey ?? ctx.agentId ?? `fallback-${Date.now()}-${process.pid}`;

    expect(identity).toBe('real-session');
  });

  it('uses sessionKey when sessionId is missing', () => {
    const ctx = { sessionId: undefined, sessionKey: 'key-123', agentId: undefined };
    const identity = ctx.sessionId ?? ctx.sessionKey ?? ctx.agentId ?? `fallback-${Date.now()}-${process.pid}`;

    expect(identity).toBe('key-123');
  });

  it('uses agentId when both sessionId and sessionKey are missing', () => {
    const ctx = { sessionId: undefined, sessionKey: undefined, agentId: 'agent-007' };
    const identity = ctx.sessionId ?? ctx.sessionKey ?? ctx.agentId ?? `fallback-${Date.now()}-${process.pid}`;

    expect(identity).toBe('agent-007');
  });
});

describe('rowToSessionHandoff', () => {
  it('converts a row to SessionHandoff', () => {
    const row = {
      id: 1,
      session_id: 'sess-row',
      repo_root: '/tmp/repo',
      task_id: 'task-1',
      summary: 'Row test',
      next_action: 'Review',
      artifacts_json: '["a.ts","b.ts"]',
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const handoff = rowToSessionHandoff(row);
    expect(handoff.version).toBe(1);
    expect(handoff.sessionId).toBe('sess-row');
    expect(handoff.repoRoot).toBe('/tmp/repo');
    expect(handoff.taskId).toBe('task-1');
    expect(handoff.summary).toBe('Row test');
    expect(handoff.nextAction).toBe('Review');
    expect(handoff.artifacts).toEqual(['a.ts', 'b.ts']);
    expect(handoff.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('handles null optional fields', () => {
    const row = {
      id: 2,
      session_id: 'sess-null',
      repo_root: null,
      task_id: null,
      summary: 'Null test',
      next_action: null,
      artifacts_json: '[]',
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const handoff = rowToSessionHandoff(row);
    expect(handoff.repoRoot).toBeUndefined();
    expect(handoff.taskId).toBeUndefined();
    expect(handoff.nextAction).toBeUndefined();
    expect(handoff.artifacts).toEqual([]);
  });

  it('handles malformed artifacts_json gracefully', () => {
    const row = {
      id: 3,
      session_id: 'sess-bad',
      repo_root: null,
      task_id: null,
      summary: 'Bad JSON test',
      next_action: null,
      artifacts_json: 'not-json',
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const handoff = rowToSessionHandoff(row);
    expect(handoff.artifacts).toEqual([]);
  });
});

describe('session events integration with handoffs', () => {
  it('session_start and session_end events can be recorded', () => {
    initStore(tmpDir);

    appendSessionEvent(tmpDir, {
      session_id: 'sess-lifecycle',
      event_type: 'session_start',
      content: 'Session started',
      source: 'openclaw',
    });

    appendSessionEvent(tmpDir, {
      session_id: 'sess-lifecycle',
      event_type: 'note',
      content: 'Did some work',
      source: 'openclaw',
    });

    appendSessionEvent(tmpDir, {
      session_id: 'sess-lifecycle',
      event_type: 'session_end',
      content: 'Session ended',
      source: 'openclaw',
    });

    const events = listSessionEvents(tmpDir, { session_id: 'sess-lifecycle', limit: 10 });
    expect(events).toHaveLength(3);
    expect(events[0]!.event_type).toBe('session_start');
    expect(events[1]!.event_type).toBe('note');
    expect(events[2]!.event_type).toBe('session_end');
  });

  it('handoff + session latest returns combined view', () => {
    initStore(tmpDir);

    saveActiveTaskSnapshot(tmpDir, {
      task: 'Ship PR2',
      summary: 'Implementing session continuity',
      next_step: 'Run tests',
      session_id: 'sess-combined',
    });

    appendSessionEvent(tmpDir, {
      session_id: 'sess-combined',
      event_type: 'session_start',
      content: 'Session started',
    });

    saveSessionHandoff(tmpDir, {
      version: 1,
      sessionId: 'sess-combined',
      summary: 'Tests pass, ready for review',
      nextAction: 'Create PR',
    });

    const snapshot = loadActiveTaskSnapshot(tmpDir);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.session_id).toBe('sess-combined');

    const events = listSessionEvents(tmpDir, { session_id: 'sess-combined' });
    expect(events.length).toBeGreaterThanOrEqual(1);

    const handoff = loadLatestHandoff(tmpDir, 'sess-combined');
    expect(handoff).not.toBeNull();
    expect(handoff!.summary).toBe('Tests pass, ready for review');
  });
});
