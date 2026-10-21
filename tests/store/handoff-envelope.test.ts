// W1 handoff envelope (trajectories/01M2BQTM4AGFVMYY7G2XV5G7WY/plan.md), tests 1-6 and fix 4: schema, round trip, opts, stamping, session-end write.
// Real temp SQLite stores throughout; no mocked DB.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openHippoDb,
  closeHippoDb,
  getSchemaVersion,
  getCurrentSchemaVersion,
  type DatabaseSyncLike,
} from '../../src/db/index.js';
import { LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION_STR } from '../_helpers/schema-version.js';
import { makeRoot } from '../_helpers/make-root.js';
import {
  loadHandoffById,
  loadLatestHandoff,
  stampHandoffOutcome,
  writeSessionEndHandoff,
  saveActiveTaskSnapshot,
  appendSessionEvent,
  saveSessionHandoff,
} from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

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
  root = makeRoot('w1-handoff', { init: false });
});

describe('fresh store, single open', () => {
  it('gets the five columns, the index, and schema_version 42 from one openHippoDb call', () => {
    const db = openHippoDb(root);
    try {
      const cols = columns(db, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']),
      );
      expect(indexNames(db, 'session_handoffs')).toContain('idx_session_handoffs_tenant_outcome');
      expect(getMeta(db, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      expect(getSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(getCurrentSchemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      closeHippoDb(db);
    }
  });
});

describe('v41 store upgrades to v42', () => {
  it('gains the five columns on next open, reads existing rows at empty defaults', () => {
    initTestStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      db1.exec(PRE_W1_SESSION_HANDOFFS_DDL);
      db1
        .prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-old', 'pre-w1 summary', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `)
        .run();
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      const cols = columns(db2, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']),
      );
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
    initTestStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
      const cols = columns(db2, 'session_handoffs').map((c) => c.name);
      expect(cols).toEqual(
        expect.arrayContaining(['constraints_json', 'evidence_json', 'outcome', 'target_runtime', 'card_id']),
      );
    } finally {
      closeHippoDb(db2);
    }
  });
});

describe('round trip of new fields', () => {
  it('saveSessionHandoff / loadHandoffById round-trips constraints, evidence, outcome, targetRuntime, cardId', () => {
    initTestStore(root);
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
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-malformed',
      summary: 'Malformed json',
      artifacts: [],
    });

    const db = openHippoDb(root);
    try {
      db.prepare(
        `UPDATE session_handoffs SET constraints_json = 'not-json', evidence_json = 'also-not-json' WHERE session_id = 'sess-malformed'`,
      ).run();
    } finally {
      closeHippoDb(db);
    }

    const loaded = loadLatestHandoff(root, 'default', 'sess-malformed');
    expect(loaded!.constraints).toEqual([]);
    expect(loaded!.evidence).toBeNull();
  });

  it('a damaged or wrong-shaped JSON column reads as empty and logs the table, row and column, never the text', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-damaged',
      summary: 'Damaged columns',
      artifacts: ['kept.md'],
    });
    const db = openHippoDb(root);
    let id: number;
    try {
      db.prepare(
        `UPDATE session_handoffs SET artifacts_json = '{private-artifact', constraints_json = '[private-constraint', evidence_json = '{"gitRef":42,"note":"private-evidence"}' WHERE session_id = 'sess-damaged'`,
      ).run();
      // SAFETY: the row was saved above, so the id column is there.
      id = (db.prepare(`SELECT id FROM session_handoffs WHERE session_id = 'sess-damaged'`).get() as { id: number }).id;
    } finally {
      closeHippoDb(db);
    }

    // A column an earlier case named at warn repeats at debug for the rest of the process, so this case reads at debug.
    vi.stubEnv('HIPPO_LOG', 'debug');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let logged: string;
    try {
      const loaded = loadLatestHandoff(root, 'default', 'sess-damaged');
      expect([loaded!.artifacts, loaded!.constraints, loaded!.evidence]).toEqual([[], [], null]);
      logged = stderr.mock.calls.map((c) => String(c[0])).join('');
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(logged).toMatch(
      new RegExp(
        `(warn|debug): store: session_handoffs\\.artifacts_json is not valid JSON; read as empty .*table=session_handoffs id=${id} column=artifacts_json`,
      ),
    );
    expect(logged).toMatch(
      new RegExp(`session_handoffs\\.constraints_json is not valid JSON.* id=${id} column=constraints_json`),
    );
    expect(logged).toMatch(
      new RegExp(`session_handoffs\\.evidence_json is wrong shape.* id=${id} column=evidence_json`),
    );
    expect(logged).not.toContain('private-');
  });
});

describe('loadLatestHandoff opts', () => {
  it('unfinishedOnly skips success rows; maxAgeMs excludes stale rows; no-opts call is unchanged', () => {
    initTestStore(root);
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-multi',
      summary: 'first',
      artifacts: [],
      outcome: 'success',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-multi',
      summary: 'second (newest)',
      artifacts: [],
      outcome: null,
    });

    // No opts: existing behaviour, newest row regardless of outcome.
    const newest = loadLatestHandoff(root, 'default', 'sess-multi');
    expect(newest!.summary).toBe('second (newest)');

    const db = openHippoDb(root);
    try {
      db.prepare(
        `UPDATE session_handoffs SET outcome = 'success' WHERE session_id = 'sess-multi' AND summary = 'second (newest)'`,
      ).run();
    } finally {
      closeHippoDb(db);
    }
    // Both rows are now 'success'; unfinishedOnly must find none.
    expect(loadLatestHandoff(root, 'default', 'sess-multi', { unfinishedOnly: true })).toBeNull();

    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-multi',
      summary: 'third partial',
      artifacts: [],
      outcome: 'partial',
    });
    const unfinished = loadLatestHandoff(root, 'default', 'sess-multi', { unfinishedOnly: true });
    expect(unfinished!.summary).toBe('third partial');

    // Isolated session: only row is old, so maxAgeMs has nothing else to fall back to.
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-age', summary: 'stale', artifacts: [] });
    const db2 = openHippoDb(root);
    try {
      db2
        .prepare(`UPDATE session_handoffs SET created_at = '2000-01-01T00:00:00.000Z' WHERE session_id = 'sess-age'`)
        .run();
    } finally {
      closeHippoDb(db2);
    }
    expect(loadLatestHandoff(root, 'default', 'sess-age', { maxAgeMs: 60_000 })).toBeNull();
    expect(loadLatestHandoff(root, 'default', 'sess-age')!.summary).toBe('stale');
  });
});

describe('stampHandoffOutcome', () => {
  it('stamps only the newest null-outcome row for the session; returns 0 when none qualify', () => {
    initTestStore(root);
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

describe('writeSessionEndHandoff', () => {
  it('6a: writes from an active snapshot owned by the session', () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'ship W1',
      summary: 'writing the envelope',
      nextStep: 'run the tests',
      sessionId: 'sess-a',
      scope: null,
    });

    const handoff = writeSessionEndHandoff(root, {
      tenantId: 'default',
      sessionId: 'sess-a',
      evidence: { gitRef: 'deadbeef', dirtyTree: false, testStatus: 'pass' },
    });
    expect(handoff).not.toBeNull();
    expect(handoff!.taskId).toBe('ship W1');
    expect(handoff!.summary).toBe('writing the envelope');
    expect(handoff!.nextAction).toBe('run the tests');
    expect(handoff!.evidence).toEqual({ gitRef: 'deadbeef', dirtyTree: false, testStatus: 'pass' });
  });

  it("6b: returns null for another session's snapshot", () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'owned by sess-a',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-a',
    });

    expect(writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-b', evidence: null })).toBeNull();
  });

  it('6c: returns null when no active snapshot exists', () => {
    initTestStore(root);
    expect(writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-none', evidence: null })).toBeNull();
  });

  it('6d: returns null when a handoff strictly newer than the snapshot exists', () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-d',
    });
    saveSessionHandoff(root, 'default', {
      version: 1,
      sessionId: 'sess-d',
      summary: 'already wrote one',
      artifacts: [],
    });

    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE task_snapshots SET updated_at = '2026-01-01T00:00:00.000Z' WHERE session_id = 'sess-d'`).run();
      db.prepare(
        `UPDATE session_handoffs SET created_at = '2026-01-01T00:00:00.001Z' WHERE session_id = 'sess-d'`,
      ).run();
    } finally {
      closeHippoDb(db);
    }

    expect(writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-d', evidence: null })).toBeNull();
  });

  it('6e: a handoff whose created_at equals snapshot.updated_at to the millisecond does NOT suppress the write', () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-e',
    });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-e', summary: 'tie handoff', artifacts: [] });

    const tie = '2026-02-02T00:00:00.000Z';
    const db = openHippoDb(root);
    try {
      db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE session_id = 'sess-e'`).run(tie);
      db.prepare(`UPDATE session_handoffs SET created_at = ? WHERE session_id = 'sess-e'`).run(tie);
      // SAFETY: row's shape matches the single `c` column selected below.
      const before = (
        db.prepare(`SELECT COUNT(*) as c FROM session_handoffs WHERE session_id = 'sess-e'`).get() as { c: number }
      ).c;
      expect(before).toBe(1);
    } finally {
      closeHippoDb(db);
    }

    const written = writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-e', evidence: null });
    expect(written).not.toBeNull();

    const db2 = openHippoDb(root);
    try {
      // SAFETY: row's shape matches the single `c` column selected below.
      const after = (
        db2.prepare(`SELECT COUNT(*) as c FROM session_handoffs WHERE session_id = 'sess-e'`).get() as { c: number }
      ).c;
      expect(after).toBe(2);
    } finally {
      closeHippoDb(db2);
    }
  });

  it('6f: copies a valid outcome from the newest session_complete event, null when invalid', () => {
    initTestStore(root);
    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-f1',
    });
    appendSessionEvent(root, 'default', { sessionId: 'sess-f1', eventType: 'session_complete', content: 'success' });
    const withOutcome = writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-f1', evidence: null });
    expect(withOutcome!.outcome).toBe('success');

    saveActiveTaskSnapshot(root, 'default', {
      task: 'task',
      summary: 'summary',
      nextStep: 'next',
      sessionId: 'sess-f2',
    });
    appendSessionEvent(root, 'default', {
      sessionId: 'sess-f2',
      eventType: 'session_complete',
      content: 'not-a-real-outcome',
    });
    const withoutOutcome = writeSessionEndHandoff(root, { tenantId: 'default', sessionId: 'sess-f2', evidence: null });
    expect(withoutOutcome!.outcome).toBeNull();
  });
});

describe('fix 4: v42 migration backfills outcome from session_complete events', () => {
  it('backfills success from the newest session_complete event; leaves eventless rows null', () => {
    initTestStore(root);
    const db1 = openHippoDb(root);
    try {
      db1.exec('DROP TABLE session_handoffs');
      db1.exec(PRE_W1_SESSION_HANDOFFS_DDL);
      db1
        .prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-done', 'done work', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `)
        .run();
      db1
        .prepare(`
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, created_at, tenant_id)
        VALUES ('sess-noevent', 'no event', '[]', '2026-01-01T00:00:00.000Z', 'default')
      `)
        .run();
      db1
        .prepare(`
        INSERT INTO session_events(session_id, event_type, content, source, metadata_json, created_at, tenant_id)
        VALUES ('sess-done', 'session_complete', 'success', 'test', '{}', '2026-01-01T00:01:00.000Z', 'default')
      `)
        .run();
      setMeta(db1, 'schema_version', '41');
    } finally {
      closeHippoDb(db1);
    }

    const db2 = openHippoDb(root);
    try {
      expect(getMeta(db2, 'schema_version')).toBe(LATEST_SCHEMA_VERSION_STR);
    } finally {
      closeHippoDb(db2);
    }

    const done = loadHandoffById(root, 'default', 1);
    expect(done!.outcome).toBe('success');
    const noEvent = loadHandoffById(root, 'default', 2);
    expect(noEvent!.outcome).toBeNull();
  });
});
