// W1 handoff envelope (trajectories/01M2BQTM4AGFVMYY7G2XV5G7WY/plan.md), tests 1-6.
// Real temp SQLite stores throughout; no mocked DB.
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import {
  initStore,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  loadHandoffById,
  loadLatestHandoff,
  stampHandoffOutcome,
  writeSessionEndHandoff,
  appendSessionEvent,
  closeTaskSnapshotsForSession,
} from '../src/store.js';
import { openHippoDb, closeHippoDb, getSchemaVersion, getCurrentSchemaVersion, type DatabaseSyncLike } from '../src/db.js';
import { getContext, adminActor } from '../src/api.js';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function columns(db: DatabaseSyncLike, table: string): ColumnInfo[] {
  // SAFETY: PRAGMA table_info always yields rows shaped like ColumnInfo.
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
}

function indexNames(db: DatabaseSyncLike, table: string): string[] {
  // SAFETY: PRAGMA index_list always yields rows with a `name` column.
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((r) => r.name);
}

function getMeta(db: DatabaseSyncLike, key: string): string | undefined {
  // SAFETY: row shape matches the single `value` column selected below.
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value?: string } | undefined)?.value;
}

function setMeta(db: DatabaseSyncLike, key: string, value: string): void {
  db.prepare(`UPDATE meta SET value = ? WHERE key = ?`).run(value, key);
}

// Pre-W1 shape of session_handoffs (the DDL as it stood before the v42 migration).
const PRE_W1_SESSION_HANDOFFS_DDL = `
  CREATE TABLE session_handoffs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    repo_root TEXT,
    task_id TEXT,
    summary TEXT NOT NULL,
    next_action TEXT,
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    scope TEXT
  )
`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-w1-handoff-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('test 1: fresh store, single open', () => {
  it('gets the five columns, the index, and schema_version 42 from one openHippoDb call', () => {
    const db = openHippoDb(root);
    try {
      const cols = columns(db, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']));
      expect(indexNames(db, 'session_handoffs')).toContain('idx_session_handoffs_tenant_outcome');
      expect(getMeta(db, 'schema_version')).toBe('42');
      expect(getSchemaVersion(db)).toBe(42);
      expect(getCurrentSchemaVersion()).toBe(42);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('test 2: v41 store upgrades to v42', () => {
  it('gains the five columns on next open, reads existing rows at empty defaults', () => {
    initStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      db1.exec(PRE_W1_SESSION_HANDOFFS_DDL);
      db1.prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-old', 'pre-w1 summary', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `).run();
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe('42');
      const cols = columns(db2, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']));
    } finally {
      closeHippoDb(db2);
    }

    const handoff = loadHandoffById(root, 'default', 1);
    expect(handoff).not.toBeNull();
    expect(handoff!.constraints).toEqual([]);
    expect(handoff!.evidence).toBeNull();
    expect(handoff!.outcome).toBeNull();
  });

  it('self-heals a v41 store whose session_handoffs table was dropped (2026-08-15 incident shape)', () => {
    initStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe('42');
      const cols = columns(db2, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']));
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('test 3: round trip of new fields', () => {
  it('saveSessionHandoff / loadHandoffById round-trips constraints, evidence, outcome, targetRuntime, cardId', () => {
    initStore(root);
    const saved = saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-full',
      summary: 'Full envelope',
      artifacts: [],
      constraints: ['no schema break', 'ship additive'],
      evidence: { gitRef: 'abc123', dirtyTree: false, testStatus: 'pass' },
      outcome: 'partial',
      targetRuntime: 'codex',
      cardId: 'card-1',
    });

    expect(saved.constraints).toEqual(['no schema break', 'ship additive']);
    expect(saved.evidence).toEqual({ gitRef: 'abc123', dirtyTree: false, testStatus: 'pass' });
    expect(saved.outcome).toBe('partial');
    expect(saved.targetRuntime).toBe('codex');
    expect(saved.cardId).toBe('card-1');

    const loaded = loadLatestHandoff(root, 'default', 'sess-full');
    expect(loaded).toEqual(saved);
  });

  it('malformed constraints_json and evidence_json read back as [] and null', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-malformed',
      summary: 'Malformed json',
      artifacts: [],
    });

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE session_handoffs SET constraints_json = 'not-json', evidence_json = 'also-not-json' WHERE session_id = 'sess-malformed'`).run();
    } finally {
      closeHippoDb(db);
    }

    const loaded = loadLatestHandoff(root, 'default', 'sess-malformed');
    expect(loaded!.constraints).toEqual([]);
    expect(loaded!.evidence).toBeNull();
  });
});

describe('test 4: loadLatestHandoff opts', () => {
  it('unfinishedOnly skips success rows; maxAgeMs excludes stale rows; no-opts call is unchanged', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-multi', summary: 'first', artifacts: [], outcome: 'success' });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-multi', summary: 'second (newest)', artifacts: [], outcome: null });

    // No opts: existing behaviour, newest row regardless of outcome.
    const newest = loadLatestHandoff(root, 'default', 'sess-multi');
    expect(newest!.summary).toBe('second (newest)');

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE session_handoffs SET outcome = 'success' WHERE session_id = 'sess-multi' AND summary = 'second (newest)'`).run();
    } finally {
      closeHippoDb(db);
    }
    // Both rows are now 'success'; unfinishedOnly must find none.
    expect(loadLatestHandoff(root, 'default', 'sess-multi', { unfinishedOnly: true })).toBeNull();

    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-multi', summary: 'third partial', artifacts: [], outcome: 'partial' });
    const unfinished = loadLatestHandoff(root, 'default', 'sess-multi', { unfinishedOnly: true });
    expect(unfinished!.summary).toBe('third partial');

    // Isolated session: only row is old, so maxAgeMs has nothing else to fall back to.
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-age', summary: 'stale', artifacts: [] });
    const db2 = openHippoDb(root);
    try {
      db2.prepare(`UPDATE session_handoffs SET created_at = '2000-01-01T00:00:00.000Z' WHERE session_id = 'sess-age'`).run();
    } finally {
      closeHippoDb(db2);
    }
    expect(loadLatestHandoff(root, 'default', 'sess-age', { maxAgeMs: 60_000 })).toBeNull();
    expect(loadLatestHandoff(root, 'default', 'sess-age')!.summary).toBe('stale');
  });
});

describe('test 5: stampHandoffOutcome', () => {
  it('stamps only the newest null-outcome row for the session; returns 0 when none qualify', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-stamp', summary: 'older', artifacts: [] });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-stamp', summary: 'newer', artifacts: [] });

    const changed = stampHandoffOutcome(root, 'default', 'sess-stamp', 'success');
    expect(changed).toBe(1);

    const newest = loadLatestHandoff(root, 'default', 'sess-stamp');
    expect(newest!.outcome).toBe('success');

    // Newest already stamped: a second stamp call must not touch the older row.
    expect(stampHandoffOutcome(root, 'default', 'sess-stamp', 'failure')).toBe(0);

    expect(stampHandoffOutcome(root, 'default', 'sess-no-rows', 'success')).toBe(0);
  });
});

describe('test 6: writeSessionEndHandoff', () => {
  it('6a: writes from an active snapshot owned by the session', () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'ship W1',
      summary: 'writing the envelope',
      next_step: 'run the tests',
      session_id: 'sess-a',
      scope: null,
    });

    const handoff = writeSessionEndHandoff(root, 'default', 'sess-a', { gitRef: 'deadbeef', dirtyTree: false, testStatus: 'pass' });
    expect(handoff).not.toBeNull();
    expect(handoff!.taskId).toBe('ship W1');
    expect(handoff!.summary).toBe('writing the envelope');
    expect(handoff!.nextAction).toBe('run the tests');
    expect(handoff!.evidence).toEqual({ gitRef: 'deadbeef', dirtyTree: false, testStatus: 'pass' });
  });

  it('6b: returns null for another session\'s snapshot', () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'owned by sess-a',
      summary: 'summary',
      next_step: 'next',
      session_id: 'sess-a',
    });

    expect(writeSessionEndHandoff(root, 'default', 'sess-b', null)).toBeNull();
  });

  it('6c: returns null when no active snapshot exists', () => {
    initStore(root);
    expect(writeSessionEndHandoff(root, 'default', 'sess-none', null)).toBeNull();
  });

  it('6d: returns null when a handoff strictly newer than the snapshot exists', () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      next_step: 'next',
      session_id: 'sess-d',
    });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-d', summary: 'already wrote one', artifacts: [] });

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE task_snapshots SET updated_at = '2026-01-01T00:00:00.000Z' WHERE session_id = 'sess-d'`).run();
      db.prepare(`UPDATE session_handoffs SET created_at = '2026-01-01T00:00:00.001Z' WHERE session_id = 'sess-d'`).run();
    } finally {
      closeHippoDb(db);
    }

    expect(writeSessionEndHandoff(root, 'default', 'sess-d', null)).toBeNull();
  });

  it('6e: a handoff whose created_at equals snapshot.updated_at to the millisecond does NOT suppress the write', () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      next_step: 'next',
      session_id: 'sess-e',
    });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-e', summary: 'tie handoff', artifacts: [] });

    const tie = '2026-02-02T00:00:00.000Z';
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE session_id = 'sess-e'`).run(tie);
      db.prepare(`UPDATE session_handoffs SET created_at = ? WHERE session_id = 'sess-e'`).run(tie);
      // SAFETY: row's shape matches the single `c` column selected below.
      const before = (db.prepare(`SELECT COUNT(*) as c FROM session_handoffs WHERE session_id = 'sess-e'`).get() as { c: number }).c;
      expect(before).toBe(1);
    } finally {
      closeHippoDb(db);
    }

    const written = writeSessionEndHandoff(root, 'default', 'sess-e', null);
    expect(written).not.toBeNull();

    const db2 = openHippoDb(root);
    try {
      // SAFETY: row's shape matches the single `c` column selected below.
      const after = (db2.prepare(`SELECT COUNT(*) as c FROM session_handoffs WHERE session_id = 'sess-e'`).get() as { c: number }).c;
      expect(after).toBe(2);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('6f: copies a valid outcome from the newest session_complete event, null when invalid', () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      next_step: 'next',
      session_id: 'sess-f1',
    });
    appendSessionEvent(root, 'default', { session_id: 'sess-f1', event_type: 'session_complete', content: 'success' });
    const withOutcome = writeSessionEndHandoff(root, 'default', 'sess-f1', null);
    expect(withOutcome!.outcome).toBe('success');

    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      next_step: 'next',
      session_id: 'sess-f2',
    });
    appendSessionEvent(root, 'default', { session_id: 'sess-f2', event_type: 'session_complete', content: 'not-a-real-outcome' });
    const withoutOutcome = writeSessionEndHandoff(root, 'default', 'sess-f2', null);
    expect(withoutOutcome!.outcome).toBeNull();
  });
});

describe('test 7: IC-SMDP fixture, ambient handoff pop-off', () => {
  it('surfaces the newest unfinished handoff, then the next one after each stamp', async () => {
    initStore(root);
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };

    for (let i = 1; i <= 10; i++) {
      const sessionId = `sess-${i}`;
      saveActiveTaskSnapshot(root, 'default', {
        task: `T_${i}`,
        summary: `summary ${i}`,
        next_step: `next ${i}`,
        session_id: sessionId,
      });
      writeSessionEndHandoff(root, 'default', sessionId, { gitRef: `ref${i}`, dirtyTree: false, testStatus: 'pass' });
      closeTaskSnapshotsForSession(root, 'default', sessionId);
    }

    const fresh = await getContext(ctx, { currentSessionId: 'fresh-session' });
    expect(fresh.sessionHandoff?.taskId).toBe('T_10');

    expect(stampHandoffOutcome(root, 'default', 'sess-10', 'success')).toBe(1);
    const afterOne = await getContext(ctx, { currentSessionId: 'fresh-session' });
    expect(afterOne.sessionHandoff?.taskId).toBe('T_9');

    for (let i = 1; i <= 9; i++) {
      stampHandoffOutcome(root, 'default', `sess-${i}`, 'success');
    }
    const afterAll = await getContext(ctx, { currentSessionId: 'fresh-session' });
    expect(afterAll.sessionHandoff).toBeUndefined();
  });
});

describe('test 8: scope filtering on the continuity read paths', () => {
  it('8a: ambient fallback does not surface a private-scoped unfinished handoff', async () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-priv', summary: 'private', artifacts: [], scope: 'slack:private:C1',
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'fresh' });
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8b: ambient fallback does not surface an unknown:legacy scoped unfinished handoff', async () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-legacy', summary: 'legacy', artifacts: [], scope: 'unknown:legacy',
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'fresh' });
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8c: ambient fallback surfaces a null-scoped unfinished handoff', async () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-pub', summary: 'public', artifacts: [], scope: null,
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'fresh' });
    expect(result.sessionHandoff?.sessionId).toBe('sess-pub');
  });

  it('8d: session-keyed path does not inject a private-scoped active snapshot or handoff', async () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task', summary: 'summary', next_step: 'next',
      session_id: 'sess-priv-active', scope: 'slack:private:C1',
    });
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-priv-active', summary: 'private handoff', artifacts: [], scope: 'slack:private:C1',
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'sess-priv-active' });
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8e: session-keyed path does not fall through to another session\'s unfinished handoff', async () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task', summary: 'summary', next_step: 'next',
      session_id: 'sess-a', scope: 'slack:private:C1',
    });
    saveSessionHandoff(root, 'default', {
      version: 1, sessionId: 'sess-b', summary: 'unrelated handoff', artifacts: [],
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'sess-a' });
    // pre-fix: activeSnapshot (scope-filtered) was null, so keying on activeSnapshot?.session_id fell through to the ambient unfinishedOnly lookup and surfaced sess-b's handoff.
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.sessionHandoff).toBeUndefined();
  });

  it('8f: recentEvents admits each event on its own scope, keyed on the raw snapshot', async () => {
    initStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'private task', summary: 'summary', next_step: 'next',
      session_id: 'sess-mix', scope: 'proj:private:x',
    });
    appendSessionEvent(root, 'default', {
      session_id: 'sess-mix', event_type: 'note', content: 'public event',
    });
    appendSessionEvent(root, 'default', {
      session_id: 'sess-mix', event_type: 'note', content: 'private event', scope: 'proj:private:x',
    });
    const ctx = { hippoRoot: root, tenantId: 'default', actor: adminActor('test') };
    const result = await getContext(ctx, { currentSessionId: 'sess-mix' });
    expect(result.activeSnapshot).toBeUndefined();
    expect(result.recentEvents).toHaveLength(1);
    expect(result.recentEvents?.[0].content).toBe('public event');
  });
});

describe('test 9: helper swap leaves no local passesScopeFilter clone', () => {
  it('src/api.ts, src/cli.ts and src/mcp/server.ts declare no local passesScopeFilter const', () => {
    for (const rel of ['api.ts', 'cli.ts', 'mcp/server.ts']) {
      const content = readFileSync(join(__dirname, '..', 'src', rel), 'utf8');
      expect(content).not.toMatch(/const passesScopeFilter\b/);
    }
  });
});

describe('fix 1: unfinishedOnly selects the newest revision per session', () => {
  it('does not resurrect an older null-outcome revision after the newest is stamped', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-s', summary: 'older', artifacts: [] });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-s', summary: 'newer', artifacts: [] });
    expect(stampHandoffOutcome(root, 'default', 'sess-s', 'success')).toBe(1);

    // Session S is fully done: ambient unfinishedOnly must not fall back to its older null row.
    expect(loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true })).toBeNull();

    // A genuinely unfinished session still surfaces.
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-t', summary: 'still open', artifacts: [] });
    const unfinished = loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true });
    expect(unfinished!.sessionId).toBe('sess-t');
  });
});

describe('fix 2: scopeFilter default-deny admits scope before LIMIT 1', () => {
  it('skips a newer private-scoped row to return an older public one', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-pub', summary: 'public', artifacts: [], scope: null });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-priv', summary: 'private', artifacts: [], scope: 'proj:private:x' });

    const admitted = loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true, scopeFilter: 'default-deny' });
    expect(admitted!.sessionId).toBe('sess-pub');
  });

  it('skips an unknown:legacy scoped row', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-pub2', summary: 'public', artifacts: [], scope: null });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-legacy', summary: 'legacy', artifacts: [], scope: 'unknown:legacy' });

    const admitted = loadLatestHandoff(root, 'default', undefined, { unfinishedOnly: true, scopeFilter: 'default-deny' });
    expect(admitted!.sessionId).toBe('sess-pub2');
  });
});

describe('fix 3: writeSessionEndHandoff carries forward same-task envelope metadata', () => {
  it('same task keeps constraints/cardId/targetRuntime/artifacts/repoRoot; a different task does not inherit them', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-carry',
      taskId: 'T',
      summary: 'explicit handoff',
      artifacts: ['file.ts'],
      constraints: ['no schema break'],
      cardId: 'card-9',
      targetRuntime: 'codex',
      repoRoot: '/repo/root',
    });
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T',
      summary: 'snapshot summary',
      next_step: 'next',
      session_id: 'sess-carry',
    });
    const refreshed = writeSessionEndHandoff(root, 'default', 'sess-carry', null);
    expect(refreshed!.constraints).toEqual(['no schema break']);
    expect(refreshed!.cardId).toBe('card-9');
    expect(refreshed!.targetRuntime).toBe('codex');
    expect(refreshed!.artifacts).toEqual(['file.ts']);
    expect(refreshed!.repoRoot).toBe('/repo/root');

    // Different task on refresh: nothing carries forward.
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-diff',
      taskId: 'T-old',
      summary: 'explicit handoff',
      artifacts: ['old.ts'],
      constraints: ['old constraint'],
      cardId: 'card-old',
      targetRuntime: 'old-runtime',
      repoRoot: '/old/root',
    });
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T-new',
      summary: 'snapshot summary',
      next_step: 'next',
      session_id: 'sess-diff',
    });
    const notCarried = writeSessionEndHandoff(root, 'default', 'sess-diff', null);
    expect(notCarried!.constraints).toEqual([]);
    expect(notCarried!.cardId).toBeNull();
    expect(notCarried!.targetRuntime).toBeNull();
    expect(notCarried!.artifacts).toEqual([]);
    expect(notCarried!.repoRoot).toBeUndefined();
  });

  it('same task but scope mismatch does not carry a private handoff into an unscoped envelope', () => {
    initStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-scope-mismatch',
      taskId: 'T',
      summary: 'private handoff',
      artifacts: ['secret.ts'],
      constraints: ['no schema break'],
      cardId: 'card-9',
      targetRuntime: 'codex',
      repoRoot: '/repo/root',
      scope: 'proj:private:x',
    });
    // Unscoped snapshot for the same task/session, as pre-compact and `snapshot save` produce.
    saveActiveTaskSnapshot(root, 'default', {
      task: 'T',
      summary: 'snapshot summary',
      next_step: 'next',
      session_id: 'sess-scope-mismatch',
    });
    const handoff = writeSessionEndHandoff(root, 'default', 'sess-scope-mismatch', null);
    expect(handoff!.artifacts).toEqual([]);
    expect(handoff!.constraints).toEqual([]);
    expect(handoff!.cardId).toBeNull();
    expect(handoff!.targetRuntime).toBeNull();
    expect(handoff!.repoRoot).toBeUndefined();
  });
});

describe('fix 4: v42 migration backfills outcome from session_complete events', () => {
  it('backfills success from the newest session_complete event; leaves eventless rows null', () => {
    initStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      db1.exec(PRE_W1_SESSION_HANDOFFS_DDL);
      db1.prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-done', 'done work', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `).run();
      db1.prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-noevent', 'no event', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `).run();
      db1.prepare(`
        INSERT INTO session_events(session_id, event_type, content, source, metadata_json, created_at, tenant_id)
        VALUES ('sess-done', 'session_complete', 'success', 'test', '{}', '2026-01-01T00:01:00.000Z', 'default')
      `).run();
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe('42');
    } finally {
      closeHippoDb(db2);
    }

    const done = loadHandoffById(root, 'default', 1);
    expect(done!.outcome).toBe('success');
    const noEvent = loadHandoffById(root, 'default', 2);
    expect(noEvent!.outcome).toBeNull();
  });
});

describe('CLI round trip: handoff create -> handoff latest --json', () => {
  const REPO_ROOT = join(__dirname, '..');
  const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  function toUtf8(value: string | Buffer | undefined): string {
    if (value === undefined) return '';
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }

  function runCli(cwd: string, env: Record<string, string>, ...args: string[]) {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out: stdout, status: 0 };
    } catch (e) {
      // SAFETY: execFileSync throws this exact shape (stdout/stderr/status) on a non-zero exit.
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      return { out: toUtf8(err.stdout) + toUtf8(err.stderr), status: err.status ?? 1 };
    }
  }

  // Shared by every CLI case below: a throwaway git repo plus an initialised hippo store.
  function setupCliHome() {
    const home = mkdtempSync(join(tmpdir(), 'hippo-w1-cli-'));
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const env = { HIPPO_HOME: globalDir };
    execSync('git init', { cwd: home, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: home, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: home, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: home, stdio: 'ignore' });
    const init = runCli(home, env, 'init');
    expect(init.status, init.out).toBe(0);
    return { home, env };
  }

  it('round-trips every new flag and returns a 40-char git ref', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(
        home, env, 'handoff', 'create',
        '--summary', 's',
        '--constraint', 'a',
        '--constraint', 'b',
        '--outcome', 'partial',
        '--target-runtime', 'codex',
        '--card-id', 'c1',
        '--tests', 'pass',
      );
      expect(create.status, create.out).toBe(0);

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      const { handoff } = JSON.parse(latest.out);
      expect(handoff.summary).toBe('s');
      expect(handoff.constraints).toEqual(['a', 'b']);
      expect(handoff.outcome).toBe('partial');
      expect(handoff.targetRuntime).toBe('codex');
      expect(handoff.cardId).toBe('c1');
      expect(handoff.evidence.testStatus).toBe('pass');
      expect(handoff.evidence.gitRef).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a value-less --target-runtime instead of persisting the string "true"', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'handoff', 'create', '--summary', 's', '--target-runtime');
      expect(create.status, create.out).toBe(1);
      expect(create.out).toContain('--target-runtime needs a value');

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      expect(JSON.parse(latest.out)).toEqual({ handoff: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a value-less --card-id when another flag follows it', () => {
    const { home, env } = setupCliHome();
    try {
      const create = runCli(home, env, 'handoff', 'create', '--card-id', '--summary', 's');
      expect(create.status, create.out).toBe(1);
      expect(create.out).toContain('--card-id needs a value');

      const latest = runCli(home, env, 'handoff', 'latest', '--json');
      expect(latest.status, latest.out).toBe(0);
      expect(JSON.parse(latest.out)).toEqual({ handoff: null });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
