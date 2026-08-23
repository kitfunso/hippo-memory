import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  initStore,
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  loadFreshActiveTaskSnapshot,
  closeTaskSnapshotsForSession,
  SNAPSHOT_AMBIENT_MAX_AGE_MS,
} from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';

// DF1 (docs/plans/2026-08-23-df1-snapshot-lifecycle.md) T1 tests: the
// never-expires fix for the active task snapshot ambient-injection surfaces.
// All real SQLite, no mocks — matches tests/snapshot-tenant-isolation.test.ts.

const TENANT = 'default';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-snapshot-freshness-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Direct SQL backdate of a row's `updated_at` — the project convention for
 * age tests (see tests/snapshot-tenant-isolation.test.ts sibling files). */
function backdateSnapshot(hippoRoot: string, id: number, isoTimestamp: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(`UPDATE task_snapshots SET updated_at = ? WHERE id = ?`).run(isoTimestamp, id);
  } finally {
    closeHippoDb(db);
  }
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

describe('loadFreshActiveTaskSnapshot (DF1 T1)', () => {
  it('1. RED-under-old incident pin: a 7d-old cross-session snapshot must not inject; the unchanged unbounded loadActiveTaskSnapshot still would', () => {
    initStore(tmpDir);
    const saved = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'orphaned /compact task',
      summary: 'live incident: 2026-08-15 snapshot, session f235ebd3',
      next_step: 'n/a',
      session_id: 'session-A',
      source: 'test',
    });
    backdateSnapshot(tmpDir, saved.id, isoAgo(SEVEN_DAYS_MS));

    // OLD PATH: the primitive every ambient surface called directly before
    // this fix. No age bound, no session guard — this call reproduces the
    // exact incident (proves the vulnerability is real on the unchanged
    // export, not just asserted).
    const oldPathResult = loadActiveTaskSnapshot(tmpDir, TENANT);
    expect(oldPathResult).not.toBeNull();
    expect(oldPathResult!.task).toBe('orphaned /compact task');

    // NEW PATH: the bounded wrapper, read for a DIFFERENT session, must not
    // surface the stale row.
    const freshResult = loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-B' });
    expect(freshResult).toBeNull();
  });

  it('2. owner unbounded: a 7d-old snapshot still injects for its owning session', () => {
    initStore(tmpDir);
    const saved = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'owner still working on this',
      summary: 's',
      next_step: 'n',
      session_id: 'session-A',
      source: 'test',
    });
    backdateSnapshot(tmpDir, saved.id, isoAgo(SEVEN_DAYS_MS));

    const result = loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-A' });
    expect(result).not.toBeNull();
    expect(result!.task).toBe('owner still working on this');
    expect(result!.session_id).toBe('session-A');
  });

  it('2b. null/empty/absent session ids never count as an owner match; every combo falls through to the age check', () => {
    initStore(tmpDir);

    // (a-c) snapshot.session_id = null; caller passes undefined / null / ''.
    const nullOwner = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'null-owner',
      summary: 's',
      next_step: 'n',
      session_id: null,
      source: 'test',
    });
    backdateSnapshot(tmpDir, nullOwner.id, isoAgo(SEVEN_DAYS_MS));
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: undefined })).toBeNull();
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: null })).toBeNull();
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: '' })).toBeNull();

    // (d) snapshot.session_id = '' (empty string); caller has a real id.
    const emptyOwner = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'empty-owner',
      summary: 's',
      next_step: 'n',
      session_id: '',
      source: 'test',
    });
    backdateSnapshot(tmpDir, emptyOwner.id, isoAgo(SEVEN_DAYS_MS));
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-real' })).toBeNull();

    // (e-f) snapshot.session_id = a real id; caller passes null / ''.
    const realOwner = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'real-owner',
      summary: 's',
      next_step: 'n',
      session_id: 'session-real',
      source: 'test',
    });
    backdateSnapshot(tmpDir, realOwner.id, isoAgo(SEVEN_DAYS_MS));
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: null })).toBeNull();
    expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: '' })).toBeNull();
  });

  it('3. fresh cross-session continuity preserved: a 1h-old snapshot injects for a different session', () => {
    initStore(tmpDir);
    const saved = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'still fresh',
      summary: 's',
      next_step: 'n',
      session_id: 'session-A',
      source: 'test',
    });
    backdateSnapshot(tmpDir, saved.id, isoAgo(60 * 60 * 1000));

    const result = loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-B' });
    expect(result).not.toBeNull();
    expect(result!.task).toBe('still fresh');
  });

  it('4. boundary: exactly at SNAPSHOT_AMBIENT_MAX_AGE_MS injects; 1ms past does not', () => {
    const fixedNow = new Date('2026-08-23T12:00:00.000Z');
    vi.useFakeTimers({ now: fixedNow });
    try {
      initStore(tmpDir);
      const saved = saveActiveTaskSnapshot(tmpDir, TENANT, {
        task: 'boundary case',
        summary: 's',
        next_step: 'n',
        session_id: 'session-A',
        source: 'test',
      });

      // Exactly at the bound — cross-session (age check path), still injects.
      backdateSnapshot(
        tmpDir,
        saved.id,
        new Date(fixedNow.getTime() - SNAPSHOT_AMBIENT_MAX_AGE_MS).toISOString(),
      );
      expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-B' })).not.toBeNull();

      // 1ms past the bound — does not.
      backdateSnapshot(
        tmpDir,
        saved.id,
        new Date(fixedNow.getTime() - SNAPSHOT_AMBIENT_MAX_AGE_MS - 1).toISOString(),
      );
      expect(loadFreshActiveTaskSnapshot(tmpDir, TENANT, { sessionId: 'session-B' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('closeTaskSnapshotsForSession (DF1 T1)', () => {
  it('5. scoped close: only the owning session can close the active row', () => {
    initStore(tmpDir);
    const saved = saveActiveTaskSnapshot(tmpDir, TENANT, {
      task: 'owned by session A',
      summary: 's',
      next_step: 'n',
      session_id: 'session-A',
      source: 'test',
    });
    const beforeUpdatedAt = saved.updated_at;

    const closedByB = closeTaskSnapshotsForSession(tmpDir, TENANT, 'session-B');
    expect(closedByB).toBe(0);
    const stillActive = loadActiveTaskSnapshot(tmpDir, TENANT);
    expect(stillActive).not.toBeNull();
    expect(stillActive!.status).toBe('active');
    expect(stillActive!.session_id).toBe('session-A');

    const closedByA = closeTaskSnapshotsForSession(tmpDir, TENANT, 'session-A');
    expect(closedByA).toBe(1);

    // loadActiveTaskSnapshot only ever returns status='active' rows.
    expect(loadActiveTaskSnapshot(tmpDir, TENANT)).toBeNull();

    // Confirm status + refreshed updated_at directly (the row is no longer
    // 'active' so the store's own read helpers can't see it any more).
    const db = openHippoDb(tmpDir);
    try {
      // SAFETY: the SELECT list above names exactly `status, updated_at`,
      // both NOT NULL columns on task_snapshots — the asserted shape matches.
      const row = db.prepare(`SELECT status, updated_at FROM task_snapshots WHERE id = ?`).get(saved.id) as {
        status: string;
        updated_at: string;
      };
      expect(row.status).toBe('session-ended');
      expect(row.updated_at).not.toBe(beforeUpdatedAt);
    } finally {
      closeHippoDb(db);
    }
  });
});
