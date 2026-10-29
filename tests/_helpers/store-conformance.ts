// Runs one store group's calls on sqliteStore over its own copy of a two-tenant fixture, and returns the answers and
// the audit rows so a test can assert them.
import { mkdtempSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvents } from '../../src/store/sqlite/audit/audit.js';
import { auditRowsOn } from './audit-rows.js';
import { createApiKey, revokeApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/keys/auth.js';
import { closeHippoDb, openHippoDb, withSharedStoreHandles } from '../../src/db/index.js';
import type { HippoStore, StoreGroups } from '../../src/base/ports/store-index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { runStoreConformance } from '../../src/entry/store-kit.js';
import { portOnlyStore } from './port-only-store.js';
import type { AuditEvent } from '../../src/base/ports/store/types.js';
import { initTestStore } from './store-template.js';
import { removeDir } from './remove-dir.js';
import { copyTree } from './copy-tree.js';

export const TENANT_A = 'acme';
export const TENANT_B = 'globex';
export const FIXTURE_REVOKED_AT = '2026-01-02T00:00:00.000Z';

type FixtureKey = 'adminA' | 'memberA' | 'revokedA' | 'memberB';

export interface TwoTenantFixture {
  /** The template folder; each run uses its own copy. */
  readonly dir: string;
  readonly keys: Readonly<Record<FixtureKey, string>>;
  /** Each key's bearer token, minted at seed time. */
  readonly tokens: Readonly<Record<FixtureKey, string>>;
}

/** Keys and audit rows in both tenants, the newest row pruned so the high-water id sits above every id left. */
export function seedTwoTenants(): TwoTenantFixture {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-conformance-template-'));
  initTestStore(dir);
  const db = openHippoDb(dir);
  try {
    const mint = (tenantId: string, role: 'admin' | 'member'): CreateApiKeyResult => {
      const minted = createApiKey(db, { tenantId, label: `${tenantId}-${role}`, role });
      appendAuditEvents(db, [
        { tenantId, actor: 'cli', op: 'auth_create', targetId: minted.keyId, metadata: { role } },
      ]);
      return minted;
    };
    const m = {
      adminA: mint(TENANT_A, 'admin'),
      memberB: mint(TENANT_B, 'member'),
      memberA: mint(TENANT_A, 'member'),
      revokedA: mint(TENANT_A, 'member'),
    };
    revokeApiKey(db, m.revokedA.keyId, FIXTURE_REVOKED_AT);
    for (let i = 0; i < 7; i++) {
      appendAuditEvents(db, [
        {
          tenantId: i % 2 === 0 ? TENANT_A : TENANT_B,
          actor: 'cli',
          op: 'remember',
          targetId: `mem_${i}`,
        },
      ]);
    }
    db.prepare('DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log)').run();
    const field = (f: 'keyId' | 'plaintext') => ({
      adminA: m.adminA[f],
      memberA: m.memberA[f],
      revokedA: m.revokedA[f],
      memberB: m.memberB[f],
    });
    return { dir, keys: field('keyId'), tokens: field('plaintext') };
  } finally {
    closeHippoDb(db);
  }
}

/** A store under test and a read of every audit row it holds, oldest first. */
export interface StoreSide {
  readonly store: HippoStore;
  readonly auditRows: () => readonly AuditEvent[];
}

/** A rejection as data, so an error compares like a return; a throw that is not an Error is rethrown. */
export type Outcome<R> = { readonly value: R } | { readonly error: string };

/** The value call `i` resolved to; a call that rejected fails the test. */
export function valueAt<T>(outcomes: readonly Outcome<unknown>[], i: number): T {
  const outcome = outcomes[i];
  if (outcome === undefined || !('value' in outcome)) throw new Error(`call ${i} did not resolve`);
  // SAFETY: the caller names the type its call `i` resolves to.
  return outcome.value as T;
}

export async function outcomeOf<R>(run: () => Promise<R>): Promise<Outcome<R>> {
  try {
    return { value: await run() };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { error: `${err.name}: ${err.message}` };
  }
}

/** The store the calls run on: sqliteStore, which sets every group and its local tier. */
export type FixtureStore = ReturnType<typeof sqliteStore>;

/** A store group, or 'base' for the methods HippoStore declares itself. */
export type ConformanceGroup = keyof StoreGroups | 'base';

/** What a call on `G` is handed: the group's methods, or the store itself for 'base'. */
export type GroupOf<G extends ConformanceGroup> = G extends 'base' ? FixtureStore : StoreGroups[Exclude<G, 'base'>];

/** One call on a store group; R is every value the calls in one run resolve to. */
export type GroupCall<G extends ConformanceGroup, R> = (group: GroupOf<G>, store: FixtureStore) => Promise<R>;

function groupOf<G extends ConformanceGroup>(store: FixtureStore, group: G): GroupOf<G> {
  const name: ConformanceGroup = group;
  // SAFETY: GroupOf<G> is the store for 'base' and StoreGroups[G] for every other G, as each branch reads.
  return (name === 'base' ? store : store[name]) as GroupOf<G>;
}

export interface SideResult<R> {
  readonly outcomes: readonly Outcome<R>[];
  readonly audit: readonly AuditEvent[];
}

function auditRowsAt(root: string): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return auditRowsOn(db);
  } finally {
    closeHippoDb(db);
  }
}

/** Runs the calls in order on sqliteStore over a copy of the fixture folder; a rejection becomes an outcome. */
export async function runOnFixture<G extends ConformanceGroup, R>(
  fixture: TwoTenantFixture,
  group: G,
  calls: readonly GroupCall<G, R>[],
): Promise<SideResult<R>> {
  const home = mkdtempSync(join(tmpdir(), 'hippo-conformance-'));
  try {
    const root = join(home, 'sqlite');
    copyTree(fixture.dir, root);
    const outcomes = await withSharedStoreHandles(async (session) => {
      const store = sqliteStore(root, { session });
      const methods = groupOf(store, group);
      const done: Outcome<R>[] = [];
      for (const call of calls) done.push(await outcomeOf(() => call(methods, store)));
      await store.close();
      return done;
    });
    return { outcomes, audit: auditRowsAt(root) };
  } finally {
    removeDir(home);
  }
}

/** The suite store-kit ships, run over sqliteStore and the port-only store, each on a fresh migrated folder. */
export function runPackagedConformance(): void {
  const homes: string[] = [];
  const folder = (): string => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-packaged-conformance-'));
    homes.push(home);
    initTestStore(home);
    return home;
  };
  afterAll(() => {
    for (const home of homes) removeDir(home);
  });
  describe.each([
    ['sqliteStore', (): HippoStore => sqliteStore(folder())],
    ['the port-only store', (): HippoStore => portOnlyStore(folder())],
  ])('%s', (_name, open) => {
    runStoreConformance({ describe, it, expect }, open);
  });
}
