// A session id belongs to the first owner that binds it; a second owner gets 409 so its client sets the record aside.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openHippoDb, closeHippoDb, runWithRequestStores, type DatabaseSyncLike } from '../src/db/index.js';
import { ConflictError } from '../src/core/api-errors.js';
import type { Context } from '../src/api/index.js';
import { bindSessionOwner } from '../src/server.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { TASK_OWNER_MIN_BINARY, compareSemver } from '../src/util/version.js';
import { makeRoot } from './_helpers/make-root.js';

interface StatementProto { readonly sourceSQL: string }
type StatementGet = (this: StatementProto, ...params: string[]) => object | undefined;
// SAFETY: node:sqlite has no bundled types; `get` takes SQL params and returns one row or undefined.
const { StatementSync } = createRequire(import.meta.url)('node:sqlite') as { StatementSync: { prototype: { get: StatementGet } } };

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

/** The released binary that shipped neither v53 nor v54. */
const PREVIOUS_RELEASE = '1.63.2';

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
    expect(err).toMatchObject({ status: 409, message: 'session id belongs to another caller' });
    expect(bindings().map((b) => b.owner_subject)).toEqual(['alice']);
  });

  it('same owner rebinds with no write', async () => {
    bindSessionOwner(ctx('alice'), 's1');
    const before = bindings();
    const holder = openHippoDb(home);
    holder.exec('BEGIN IMMEDIATE');
    try {
      // Another connection holds the write lock, so a rebind that asked for it would fail after the short wait.
      await expect(runWithRequestStores(() => bindSessionOwner(ctx('alice'), 's1'), { busyWaitMs: 50 })).resolves.toBeUndefined();
      await expect(runWithRequestStores(() => bindSessionOwner(ctx('alice'), 's2'), { busyWaitMs: 50 })).rejects.toThrow();
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

  it('a floor raise that fails takes the binding with it, since both are one transaction', () => {
    setFloor('0.0.1');
    withDb((db) => db.exec(`CREATE TRIGGER fail_floor BEFORE INSERT ON meta WHEN NEW.key = 'min_compatible_binary' BEGIN SELECT RAISE(ABORT, 'floor boom'); END`));
    expect(() => bindSessionOwner(ctx('alice'), 's1')).toThrow('floor boom');
    expect(bindings()).toEqual([]);
    expect(floor()).toBe('0.0.1');
  });

  it('the first bind lifts the floor above the last release before v54, which the open then refuses', () => {
    setFloor('0.0.1');
    bindSessionOwner(ctx('alice'), 's1');
    // The open refuses any binary below the floor (github-rollback-guard-and-deletion-atomicity.test.ts), so a floor above the release shuts it out.
    expect(compareSemver(floor() ?? '', PREVIOUS_RELEASE)).toBeGreaterThan(0);
  });

  it('a bind that lost the race to another owner returns the stored owner, not its own', () => {
    const get = StatementSync.prototype.get;
    let raced = false;
    // Alice commits right after Bob's read finds no owner, so he reaches the insert with her row already there.
    const read = vi.spyOn(StatementSync.prototype, 'get').mockImplementation(function (this: StatementProto, ...params: string[]) {
      const row = get.apply(this, params);
      if (raced || !this.sourceSQL.includes('FROM session_owners')) return row;
      raced = true;
      bindSessionOwner(ctx('alice'), 's1');
      return row;
    });
    try {
      expect(() => bindSessionOwner(ctx('bob'), 's1')).toThrow(ConflictError);
    } finally {
      read.mockRestore();
    }
    expect(raced).toBe(true);
    expect(bindings().map((b) => b.owner_subject)).toEqual(['alice']);
  });

  it('an owner snapshot save raises the floor', () => {
    setFloor('0.0.1');
    saveActiveTaskSnapshot(home, 'default', { task: 't', summary: 's', next_step: 'n' });
    expect(floor()).toBe('0.0.1');
    saveActiveTaskSnapshot(home, 'default', { task: 't', summary: 's', next_step: 'n' }, { owner: 'alice', project: ['p'] });
    expect(floor()).toBe(TASK_OWNER_MIN_BINARY);
  });

  it('a new bind prunes bindings older than 90 days, in every tenant, and keeps younger ones', () => {
    const daysAgo = (d: number): string => new Date(Date.now() - d * 86_400_000).toISOString();
    withDb((db) => {
      const insert = db.prepare(`INSERT INTO session_owners(tenant_id, session_id, owner_subject, created_at) VALUES (?, ?, ?, ?)`);
      insert.run('default', 'old', 'alice', daysAgo(91));
      insert.run('acme', 'old-acme', 'bob', daysAgo(91));
      insert.run('default', 'young', 'alice', daysAgo(89));
    });
    bindSessionOwner(ctx('carol'), 'new');
    expect(bindings().map((b) => b.session_id).sort()).toEqual(['new', 'young']);
  });

  it('two tenants may hold one session id', () => {
    bindSessionOwner(ctx('alice'), 's1');
    bindSessionOwner(ctx('bob', 'acme'), 's1');
    expect(bindings().map((b) => [b.tenant_id, b.owner_subject])).toEqual([['acme', 'bob'], ['default', 'alice']]);
  });
});
