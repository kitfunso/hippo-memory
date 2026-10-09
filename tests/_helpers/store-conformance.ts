// Runs one store group's calls on hippo.db's store and on another store, each over its own copy of a two-tenant fixture,
// and returns each side's answers and audit rows so a test can assert the two equal.
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvent, listAuditEventsAfter, type AuditEvent } from '../../src/store/audit.js';
import { createApiKey, revokeApiKey, type CreateApiKeyResult } from '../../src/store/auth.js';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../../src/db.js';
import { requireGroup, sqliteStore, type HippoStore, type StoreGroups } from '../../src/store-port.js';
import { initStore } from '../../src/store/open.js';

export const TENANT_A = 'acme';
export const TENANT_B = 'globex';
export const FIXTURE_REVOKED_AT = '2026-01-02T00:00:00.000Z';

type FixtureKey = 'adminA' | 'memberA' | 'revokedA' | 'memberB';

export interface TwoTenantFixture {
  /** The template folder; each side runs on its own copy. */
  readonly dir: string;
  readonly keys: Readonly<Record<FixtureKey, string>>;
  /** Each key's bearer token, minted at seed time. */
  readonly tokens: Readonly<Record<FixtureKey, string>>;
}

/** Keys and audit rows in both tenants, the newest row pruned so the high-water id sits above every id left. */
export function seedTwoTenants(): TwoTenantFixture {
  const dir = mkdtempSync(join(tmpdir(), 'hippo-conformance-template-'));
  initStore(dir);
  const db = openHippoDb(dir);
  try {
    const mint = (tenantId: string, role: 'admin' | 'member'): CreateApiKeyResult => {
      const minted = createApiKey(db, { tenantId, label: `${tenantId}-${role}`, role });
      appendAuditEvent(db, { tenantId, actor: 'cli', op: 'auth_create', targetId: minted.keyId, metadata: { role } });
      return minted;
    };
    const m = { adminA: mint(TENANT_A, 'admin'), memberB: mint(TENANT_B, 'member'), memberA: mint(TENANT_A, 'member'), revokedA: mint(TENANT_A, 'member') };
    revokeApiKey(db, m.revokedA.keyId, FIXTURE_REVOKED_AT);
    for (let i = 0; i < 7; i++) appendAuditEvent(db, { tenantId: i % 2 === 0 ? TENANT_A : TENANT_B, actor: 'cli', op: 'remember', targetId: `mem_${i}` });
    db.prepare('DELETE FROM audit_log WHERE id = (SELECT MAX(id) FROM audit_log)').run();
    const field = (f: 'keyId' | 'plaintext') => ({ adminA: m.adminA[f], memberA: m.memberA[f], revokedA: m.revokedA[f], memberB: m.memberB[f] });
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

export async function outcomeOf<R>(run: () => Promise<R>): Promise<Outcome<R>> {
  try {
    return { value: await run() };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return { error: `${err.name}: ${err.message}` };
  }
}

/** One call on a store group; R is every value the calls in one run resolve to. */
export type GroupCall<G extends keyof StoreGroups, R> = (group: StoreGroups[G], store: HippoStore) => Promise<R>;

export interface SideResult<R> {
  readonly outcomes: readonly Outcome<R>[];
  readonly audit: readonly AuditEvent[];
}

function auditRowsAt(root: string): AuditEvent[] {
  const db = openHippoDb(root);
  try {
    return listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
  } finally {
    closeHippoDb(db);
  }
}

async function runSide<G extends keyof StoreGroups, R>(
  side: StoreSide, group: G, calls: readonly GroupCall<G, R>[], guard: <T>(fn: () => T) => T,
): Promise<SideResult<R>> {
  const methods = requireGroup(side.store, group);
  const outcomes: Outcome<R>[] = [];
  for (const call of calls) outcomes.push(await outcomeOf(() => guard(() => call(methods, side.store))));
  await side.store.close();
  return { outcomes, audit: side.auditRows() };
}

/** The other side's calls run with hippo.db blocked, so a method that falls back to it throws instead of matching by accident. */
export async function onBothStores<G extends keyof StoreGroups, R>(
  fixture: TwoTenantFixture, group: G, makeOther: (root: string) => StoreSide, calls: readonly GroupCall<G, R>[],
): Promise<{ readonly sqlite: SideResult<R>; readonly other: SideResult<R> }> {
  const home = mkdtempSync(join(tmpdir(), 'hippo-conformance-'));
  try {
    const roots = { sqlite: join(home, 'sqlite'), other: join(home, 'other') };
    cpSync(fixture.dir, roots.sqlite, { recursive: true });
    cpSync(fixture.dir, roots.other, { recursive: true });
    const sqlite = await runSide({ store: sqliteStore(roots.sqlite), auditRows: () => auditRowsAt(roots.sqlite) }, group, calls, (fn) => fn());
    const otherSide = makeOther(roots.other);
    const other = await runSide(otherSide, group, calls, (fn) => withSqliteBlocked(otherSide.store.kind, fn));
    return { sqlite, other };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
