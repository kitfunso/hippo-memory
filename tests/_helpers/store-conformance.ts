// Runs one store group's calls on hippo.db's store and on memoryStore, each over its own copy of a two-tenant fixture,
// and returns each side's answers and audit rows so a test can assert the two equal.
import { cpSync, mkdtempSync } from 'node:fs';
import { expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEvents } from '../../src/store/sqlite/audit.js';
import { auditRowsOn } from './audit-rows.js';
import { createApiKey, revokeApiKey, type CreateApiKeyResult } from '../../src/store/sqlite/auth.js';
import { closeHippoDb, openHippoDb, withSqliteBlocked } from '../../src/db/index.js';
import type { HippoStore, OptionalGroup, StoreGroups } from '../../src/store/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import type { AuditEvent } from '../../src/store/port/types.js';
import { initTestStore } from './store-template.js';
import { removeAfterRequest } from './one-request-per-test.js';
import { memorySide } from './memory-side.js';

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

/** BM25 differs in the last bit between FTS5 and the memory store on some platforms, so floats compare at 12 digits. */
function roundFloats<T>(value: T): T {
  if (Number.isFinite(value) && !Number.isInteger(value)) {
    // SAFETY: Number.isFinite on a non-number is false, so value is a number here.
    return Number(Number(value).toPrecision(12)) as T;
  }
  if (Array.isArray(value)) {
    // SAFETY: map returns an array of the same element shape.
    return value.map(roundFloats) as T;
  }
  if (value != null && Object.getPrototypeOf(Object(value)) === Object.prototype) {
    // SAFETY: the entries are rebuilt under the same keys with the same value shapes.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundFloats(v)])) as T;
  }
  return value;
}

/** Asserts the two sides agree; the sides stay raw, only the compared copies have their floats rounded. */
export function expectSameOutcomes<T>(sides: { readonly other: T; readonly sqlite: T }): void {
  expect(roundFloats(sides.other)).toEqual(roundFloats(sides.sqlite));
}

export type RequiredGroup = Exclude<keyof StoreGroups, OptionalGroup>;

/** A required group, or 'base' for the methods HippoStore declares itself. */
export type ConformanceGroup = RequiredGroup | 'base';

/** What a call on `G` is handed: the group's methods, or the store itself for 'base'. */
export type GroupOf<G extends ConformanceGroup> = G extends RequiredGroup ? HippoStore[G] : HippoStore;

/** One call on a store group; R is every value the calls in one run resolve to. */
export type GroupCall<G extends ConformanceGroup, R> = (group: GroupOf<G>, store: HippoStore) => Promise<R>;

function groupOf<G extends ConformanceGroup>(store: HippoStore, group: G): GroupOf<G> {
  // SAFETY: GroupOf<G> is HippoStore for 'base' and HippoStore[G] for every other G, as the branch reads.
  return (group === 'base' ? store : store[group as RequiredGroup]) as GroupOf<G>;
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

async function runSide<G extends ConformanceGroup, R>(
  side: StoreSide,
  group: G,
  calls: readonly GroupCall<G, R>[],
  guard: <T>(fn: () => T) => T,
): Promise<SideResult<R>> {
  const methods = groupOf(side.store, group);
  const outcomes: Outcome<R>[] = [];
  for (const call of calls) outcomes.push(await outcomeOf(() => guard(() => call(methods, side.store))));
  await side.store.close();
  return { outcomes, audit: side.auditRows() };
}

/** The memory side's calls run with hippo.db blocked, so a method that falls back to it throws instead of matching by accident. */
export async function onBothStores<G extends ConformanceGroup, R>(
  fixture: TwoTenantFixture,
  group: G,
  calls: readonly GroupCall<G, R>[],
): Promise<{ readonly sqlite: SideResult<R>; readonly other: SideResult<R> }> {
  const home = mkdtempSync(join(tmpdir(), 'hippo-conformance-'));
  try {
    const roots = { sqlite: join(home, 'sqlite'), other: join(home, 'other') };
    cpSync(fixture.dir, roots.sqlite, { recursive: true });
    cpSync(fixture.dir, roots.other, { recursive: true });
    const sqlite = await runSide(
      { store: sqliteStore(roots.sqlite), auditRows: () => auditRowsAt(roots.sqlite) },
      group,
      calls,
      (fn) => fn(),
    );
    const otherSide = memorySide(roots.other);
    const other = await runSide(otherSide, group, calls, (fn) => withSqliteBlocked(otherSide.store.kind, fn));
    return { sqlite, other };
  } finally {
    removeAfterRequest(home);
  }
}
