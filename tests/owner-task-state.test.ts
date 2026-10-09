// Two developers in one tenant and one project: each keyed store call sees and changes only its own owner's task state.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openHippoDb, closeHippoDb, type DatabaseSyncLike } from '../src/db/index.js';
import { recordFailure } from '../src/store/failure-log.js';
import type { SessionHandoff } from '../src/core/handoff.js';
import {
  clearActiveTaskSnapshot,
  closeTaskSnapshotsForSession,
  loadActiveTaskSnapshot,
  loadFreshActiveTaskSnapshot,
  saveActiveTaskSnapshot,
  type ContinuityKey,
} from '../src/store/sessions.js';
import { loadLatestHandoff, saveSessionHandoff, writeSessionEndHandoff } from '../src/store/handoffs.js';
import { makeRoot } from './_helpers/make-root.js';

const T = 'default';
const A: ContinuityKey = { owner: 'alice', project: ['p'] };
const B: ContinuityKey = { owner: 'bob', project: ['p'] };
const PARTIAL: readonly ContinuityKey[] = [{ owner: 'alice', project: [] }, { owner: '', project: ['p'] }, { owner: 'alice', project: [''] }];

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function snap(task: string, session = 's1') {
  return { task, summary: `${task} summary`, next_step: `${task} next`, session_id: session };
}

function handoff(summary: string, sessionId = 's1'): Omit<SessionHandoff, 'updatedAt'> {
  return { version: 1, sessionId, summary };
}

function statusOf(id: number): string {
  // SAFETY: one TEXT column by primary key.
  return withDb((db) => (db.prepare(`SELECT status FROM task_snapshots WHERE id = ?`).get(id) as { status: string }).status);
}

function handoffRows(sessionId: string): Array<{ summary: string; owner_subject: string | null; origin_project: string | null }> {
  // SAFETY: the SELECT names exactly these three columns.
  return withDb((db) => db.prepare(`SELECT summary, owner_subject, origin_project FROM session_handoffs WHERE session_id = ? ORDER BY id`).all(sessionId) as Array<{ summary: string; owner_subject: string | null; origin_project: string | null }>);
}

const mirror = (): string => join(home, 'buffer', 'active-task.md');

beforeEach(() => {
  home = makeRoot('owner-task-state');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('task snapshots keyed by owner and project', () => {
  it('save supersedes only the same owner and project', () => {
    const a1 = saveActiveTaskSnapshot(home, T, snap('a1'), A);
    const b1 = saveActiveTaskSnapshot(home, T, snap('b1'), B);
    const aq = saveActiveTaskSnapshot(home, T, snap('aq'), { owner: 'alice', project: ['q'] });
    const a2 = saveActiveTaskSnapshot(home, T, snap('a2'), A);
    expect(statusOf(a1.id)).toBe('superseded');
    expect([statusOf(b1.id), statusOf(aq.id), statusOf(a2.id)]).toEqual(['active', 'active', 'active']);
  });

  it('loadActiveTaskSnapshot returns only the owner\'s row', () => {
    const a = saveActiveTaskSnapshot(home, T, snap('a'), A);
    const b = saveActiveTaskSnapshot(home, T, snap('b'), B);
    expect(loadActiveTaskSnapshot(home, T, A)?.id).toBe(a.id);
    expect(loadActiveTaskSnapshot(home, T, B)?.id).toBe(b.id);
  });

  it('loadFreshActiveTaskSnapshot returns only the owner\'s row', () => {
    const a = saveActiveTaskSnapshot(home, T, snap('a', 'sa'), A);
    const b = saveActiveTaskSnapshot(home, T, snap('b', 'sb'), B);
    expect(loadFreshActiveTaskSnapshot(home, T, { sessionId: 'sb' }, A)?.id).toBe(a.id);
    expect(loadFreshActiveTaskSnapshot(home, T, {}, B)?.id).toBe(b.id);
  });

  it('closeTaskSnapshotsForSession closes only the owner\'s rows', () => {
    const a = saveActiveTaskSnapshot(home, T, snap('a'), A);
    const b = saveActiveTaskSnapshot(home, T, snap('b'), B);
    expect(closeTaskSnapshotsForSession(home, T, 's1', 'session-ended', A)).toBe(1);
    expect(statusOf(a.id)).toBe('session-ended');
    expect(statusOf(b.id)).toBe('active');
  });

  it('an alias row is superseded by a save under the main name', () => {
    const old = saveActiveTaskSnapshot(home, T, snap('old'), { owner: 'alice', project: ['old-folder'] });
    const renamed: ContinuityKey = { owner: 'alice', project: ['p', 'old-folder'] };
    const now = saveActiveTaskSnapshot(home, T, snap('now'), renamed);
    expect(statusOf(old.id)).toBe('superseded');
    expect(loadActiveTaskSnapshot(home, T, renamed)?.id).toBe(now.id);
  });

  it('NULL-owner rows never reach an owner read', () => {
    const legacy = saveActiveTaskSnapshot(home, T, snap('legacy'));
    saveSessionHandoff(home, T, handoff('legacy handoff'));
    expect(loadActiveTaskSnapshot(home, T, A)).toBeNull();
    expect(loadLatestHandoff(home, T, 's1', {}, A)).toBeNull();
    expect(loadActiveTaskSnapshot(home, T)?.id).toBe(legacy.id);
    expect(loadLatestHandoff(home, T, 's1')?.summary).toBe('legacy handoff');
  });

  it('no key keeps today\'s rows', () => {
    saveActiveTaskSnapshot(home, T, snap('first'));
    const second = saveActiveTaskSnapshot(home, T, snap('second', 's2'));
    expect(loadActiveTaskSnapshot(home, T)?.id).toBe(second.id);
    expect(existsSync(mirror())).toBe(true);
    saveSessionHandoff(home, T, handoff('local'));
    expect(handoffRows('s1')).toEqual([{ summary: 'local', owner_subject: null, origin_project: null }]);
  });

  it('on a shared store an unkeyed save or clear throws and every owner\'s snapshot stays active', () => {
    rmSync(home, { recursive: true, force: true });
    home = makeRoot('owner-task-state-shared', { config: { sharedStore: true } });
    const a = saveActiveTaskSnapshot(home, T, snap('a'), A);
    const b = saveActiveTaskSnapshot(home, T, snap('b'), B);
    expect(() => saveActiveTaskSnapshot(home, T, snap('admin'))).toThrow(/needs their continuity key/);
    expect(() => clearActiveTaskSnapshot(home, T)).toThrow(/needs their continuity key/);
    expect([statusOf(a.id), statusOf(b.id)]).toEqual(['active', 'active']);
    // SAFETY: COUNT(*) returns one row with one integer column.
    expect(withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM task_snapshots`).get() as { n: number }).n)).toBe(2);
  });

  it('owner calls write and delete no mirror', () => {
    saveActiveTaskSnapshot(home, T, snap('a'), A);
    expect(existsSync(mirror())).toBe(false);
    saveActiveTaskSnapshot(home, T, snap('local'));
    expect(existsSync(mirror())).toBe(true);
    expect(loadActiveTaskSnapshot(home, T, B)).toBeNull();
    expect(existsSync(mirror())).toBe(true);
  });
});

describe('handoffs and failures keyed by owner and project', () => {
  it('saveSessionHandoff stamps owner and project', () => {
    saveSessionHandoff(home, T, handoff('mine'), { owner: 'alice', project: ['p', 'p-legacy'] });
    expect(handoffRows('s1')).toEqual([{ summary: 'mine', owner_subject: 'alice', origin_project: 'p' }]);
  });

  it('loadLatestHandoff unfinishedOnly: B\'s newer revision never hides A\'s', () => {
    saveSessionHandoff(home, T, handoff('alice half done'), A);
    saveSessionHandoff(home, T, handoff('bob half done'), B);
    expect(loadLatestHandoff(home, T, undefined, { unfinishedOnly: true }, A)?.summary).toBe('alice half done');
    expect(loadLatestHandoff(home, T, undefined, { unfinishedOnly: true }, B)?.summary).toBe('bob half done');
  });

  it('writeSessionEndHandoff reads only the owner\'s snapshot and handoff', () => {
    saveActiveTaskSnapshot(home, T, snap('alice task', 'sa'), A);
    saveActiveTaskSnapshot(home, T, snap('bob task', 'sb'), B);
    // A newer handoff of B's on A's session id would block A's write if it were read.
    saveSessionHandoff(home, T, handoff('bob note', 'sa'), B);
    const written = writeSessionEndHandoff(home, T, 'sa', null, null, A);
    expect(written?.taskId).toBe('alice task');
    expect(handoffRows('sa').at(-1)).toEqual({ summary: 'alice task summary', owner_subject: 'alice', origin_project: 'p' });
  });

  it('derived-path retry writes no second revision', () => {
    const derived = { task: 'derived', summary: 'from the transcript', next_step: 'carry on' };
    expect(writeSessionEndHandoff(home, T, 'sd', null, derived, A)?.taskId).toBe('derived');
    expect(writeSessionEndHandoff(home, T, 'sd', null, derived, A)).toBeNull();
    expect(handoffRows('sd')).toHaveLength(1);
  });

  it('recordFailure stamps owner and project', () => {
    withDb((db) => recordFailure(db, { tenantId: T, sessionId: 's1', tool: 'Bash', outcome: 'stored', ownerSubject: 'alice', originProject: 'p', requestId: 'req-1' }));
    withDb((db) => recordFailure(db, { tenantId: T, sessionId: 's1', tool: 'Bash', outcome: 'stored' }));
    // SAFETY: the SELECT names exactly these three columns.
    const rows = withDb((db) => db.prepare(`SELECT owner_subject, origin_project, request_id FROM failure_log ORDER BY id`).all());
    expect(rows).toEqual([
      { owner_subject: 'alice', origin_project: 'p', request_id: 'req-1' },
      { owner_subject: null, origin_project: null, request_id: null },
    ]);
  });
});

describe('a partial key matches nothing and writes nothing', () => {
  for (const key of PARTIAL) {
    it(`owner '${key.owner}', project [${key.project.join(',')}]`, () => {
      const own = saveActiveTaskSnapshot(home, T, snap('mine'), A);
      saveSessionHandoff(home, T, handoff('mine'), A);
      expect(loadActiveTaskSnapshot(home, T, A)?.id).toBe(own.id);
      expect(loadActiveTaskSnapshot(home, T, key)).toBeNull();
      expect(loadFreshActiveTaskSnapshot(home, T, { sessionId: 's1' }, key)).toBeNull();
      expect(loadLatestHandoff(home, T, 's1', {}, key)).toBeNull();
      expect(() => saveActiveTaskSnapshot(home, T, snap('x'), key)).toThrow(/owner and a project/);
      expect(() => closeTaskSnapshotsForSession(home, T, 's1', 'session-ended', key)).toThrow(/owner and a project/);
      expect(() => saveSessionHandoff(home, T, handoff('x'), key)).toThrow(/owner and a project/);
      expect(() => writeSessionEndHandoff(home, T, 's1', null, null, key)).toThrow(/owner and a project/);
      expect(statusOf(own.id)).toBe('active');
      expect(handoffRows('s1')).toHaveLength(1);
    });
  }
});
