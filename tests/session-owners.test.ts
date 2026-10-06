// A session id belongs to the first owner that binds it; a second owner gets 409 so its client sets the record aside.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { openHippoDb, closeHippoDb, withBusyWait, type DatabaseSyncLike } from '../src/db.js';
import { ConflictError } from '../src/api-errors.js';
import type { Context } from '../src/api.js';
import { bindSessionOwner } from '../src/server.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { TASK_OWNER_MIN_BINARY } from '../src/version.js';
import { makeRoot } from './_helpers/make-root.js';

let home: string;

function withDb<T>(fn: (db: DatabaseSyncLike) => T): T {
  const db = openHippoDb(home);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function ctx(owner: string, tenantId = 'default'): Context {
  return { hippoRoot: home, tenantId, actor: { subject: `api_key:hk_${owner}`, role: 'member', owner } };
}

function bindings(): Array<{ tenant_id: string; session_id: string; owner_subject: string; created_at: string }> {
  // SAFETY: the SELECT names exactly these four TEXT columns.
  return withDb((db) => db.prepare(`SELECT tenant_id, session_id, owner_subject, created_at FROM session_owners ORDER BY tenant_id`).all() as Array<{ tenant_id: string; session_id: string; owner_subject: string; created_at: string }>);
}

function setFloor(v: string): void {
  withDb((db) => db.prepare(`UPDATE meta SET value = ? WHERE key = 'min_compatible_binary'`).run(v));
}

function floor(): string | undefined {
  // SAFETY: one TEXT `value` column by primary key.
  return withDb((db) => (db.prepare(`SELECT value FROM meta WHERE key = 'min_compatible_binary'`).get() as { value?: string } | undefined)?.value);
}

beforeEach(() => {
  home = makeRoot('session-owners');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('bindSessionOwner', () => {
  it('first writer wins, a second owner gets a 409 ConflictError', () => {
    bindSessionOwner(ctx('alice'), 's1');
    let err: unknown;
    try {
      bindSessionOwner(ctx('bob'), 's1');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as ConflictError).status).toBe(409);
    expect((err as ConflictError).message).toBe('session id belongs to another caller');
    expect(bindings().map((b) => b.owner_subject)).toEqual(['alice']);
  });

  it('same owner rebinds with no write', () => {
    bindSessionOwner(ctx('alice'), 's1');
    const before = bindings();
    const holder = openHippoDb(home);
    holder.exec('BEGIN IMMEDIATE');
    try {
      // Another connection holds the write lock, so a rebind that asked for it would fail after the short wait.
      expect(() => withBusyWait(50, () => bindSessionOwner(ctx('alice'), 's1'))).not.toThrow();
      expect(() => withBusyWait(50, () => bindSessionOwner(ctx('alice'), 's2'))).toThrow();
    } finally {
      holder.exec('ROLLBACK');
      closeHippoDb(holder);
    }
    expect(bindings()).toEqual(before);
  });

  it('first bind raises the floor to TASK_OWNER_MIN_BINARY in its transaction', () => {
    setFloor('0.0.1');
    bindSessionOwner(ctx('alice'), 's1');
    expect(floor()).toBe(TASK_OWNER_MIN_BINARY);
    expect(bindings()).toHaveLength(1);
  });

  it('an owner snapshot save raises the floor', () => {
    setFloor('0.0.1');
    saveActiveTaskSnapshot(home, 'default', { task: 't', summary: 's', next_step: 'n' });
    expect(floor()).toBe('0.0.1');
    saveActiveTaskSnapshot(home, 'default', { task: 't', summary: 's', next_step: 'n' }, { owner: 'alice', project: ['p'] });
    expect(floor()).toBe(TASK_OWNER_MIN_BINARY);
  });

  it('two tenants may hold one session id', () => {
    bindSessionOwner(ctx('alice'), 's1');
    bindSessionOwner(ctx('bob', 'acme'), 's1');
    expect(bindings().map((b) => [b.tenant_id, b.owner_subject])).toEqual([['acme', 'bob'], ['default', 'alice']]);
  });
});
