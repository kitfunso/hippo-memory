// A store other than hippo.db for the KeyWrites group: it copies api_keys and audit_log out of hippo.db once, then keeps
// both in memory and answers with what hippo-memory/server exports, so a conformance test shows that is all another store needs.
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { listAuditEventsAfter } from '../../src/audit.js';
import { createApiKey, grantScope, listScopeGrants, revokeApiKey } from '../../src/auth.js';
import { auditHighIdAt } from '../../src/store/key-audit.js';
import type {
  ApiKeyListRow, ApiKeyRecord, AppendAuditOpts, AuditEvent, HippoStore, KeyListQuery, KeyMint, KeyWrites, NewApiKey,
} from '../../src/server.js';
import { FIXTURE_REVOKED_AT, TENANT_A, TENANT_B, type StoreSide, type TwoTenantFixture } from './store-conformance.js';
import { portOnlyStoreWithoutVectorReads } from './port-only-store.js';

export interface InMemoryKeyWritesStore extends StoreSide {
  readonly store: HippoStore & { readonly keyWrites: KeyWrites };
}

/** A stored role stays as written, since findApiKey returns it raw and only a list reads it as admin or member. */
interface KeyRow extends Omit<NewApiKey, 'role'> {
  readonly id: number;
  readonly role: string;
  readonly revokedAt: string | null;
  readonly scopes: readonly string[];
}

interface SqlKeyRow {
  id: number; key_id: string; key_hash: string; tenant_id: string; label: string | null; created_at: string;
  revoked_at: string | null; role: string; expires_at: string | null; owner_subject: string | null;
}

interface CopiedRows {
  readonly keys: Map<string, KeyRow>;
  readonly audit: AuditEvent[];
  readonly highId: number;
}

function copyRows(hippoRoot: string): CopiedRows {
  const db = openHippoDb(hippoRoot);
  try {
    const sql = 'SELECT id, key_id, key_hash, tenant_id, label, created_at, revoked_at, role, expires_at, owner_subject FROM api_keys ORDER BY id';
    // SAFETY: the SELECT names exactly SqlKeyRow's columns.
    const rows = db.prepare(sql).all() as SqlKeyRow[];
    const keys = new Map(rows.map((r): [string, KeyRow] => [r.key_id, {
      id: r.id, keyId: r.key_id, keyHash: r.key_hash, tenantId: r.tenant_id, label: r.label, createdAt: r.created_at, revokedAt: r.revoked_at,
      role: r.role, expiresAt: r.expires_at, ownerSubject: r.owner_subject, scopes: listScopeGrants(db, r.key_id),
    }]));
    return { keys, audit: listAuditEventsAfter(db, { afterId: 0, limit: 10_000 }), highId: auditHighIdAt(db) };
  } finally {
    closeHippoDb(db);
  }
}

/** The key check's expiry rule: null never expires, and a stamp that does not parse is already past. */
function expiryMs(expiresAt: string | null): number {
  if (expiresAt === null) return Infinity;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function listed(row: KeyRow, query: KeyListQuery, nowIso: string): boolean {
  if (row.tenantId !== query.tenantId) return false;
  // The SQL compares the stamps as strings, which toISOString makes correct.
  if (query.active && (row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= nowIso))) return false;
  if (query.ownerSubject !== undefined && row.ownerSubject !== query.ownerSubject) return false;
  if (query.keyId !== undefined && row.keyId !== query.keyId) return false;
  if (query.after === undefined) return true;
  const key = Number(query.after.key);
  return row.id < key || (row.id === key && row.id < Number(query.after.id));
}

function listRow({ id, keyId, tenantId, label, createdAt, revokedAt, role, scopes, expiresAt, ownerSubject }: KeyRow): ApiKeyListRow {
  return { rowId: id, key: { keyId, tenantId, label, createdAt, revokedAt, role: role === 'admin' ? 'admin' : 'member', scopes: [...scopes], expiresAt, ownerSubject } };
}

function recordOf({ keyHash, tenantId, revokedAt, role, scopes, expiresAt, ownerSubject }: KeyRow): ApiKeyRecord {
  return { keyHash, tenantId, revokedAt, role, scopes: [...scopes], expiresAt, ownerSubject };
}

const createAudit = ({ key, actor, metadata }: KeyMint): AppendAuditOpts => ({ tenantId: key.tenantId, actor, op: 'auth_create', targetId: key.keyId, metadata });

export function inMemoryKeyWritesStore(hippoRoot: string): InMemoryKeyWritesStore {
  const { keys, audit, highId } = copyRows(hippoRoot);
  let lastAuditId = highId;
  let lastRowId = Math.max(0, ...[...keys.values()].map((k) => k.id));
  const append = (event: AppendAuditOpts): void => {
    lastAuditId += 1;
    const metadata: AuditEvent['metadata'] = JSON.parse(JSON.stringify(event.metadata ?? {}));
    audit.push({ id: lastAuditId, ts: new Date().toISOString(), tenantId: event.tenantId, actor: event.actor, op: event.op, targetId: event.targetId ?? null, metadata });
  };
  // Checked before any change, so a refused insert leaves the store as it was, as a rolled-back transaction does.
  const insert = (key: NewApiKey): void => {
    if (keys.has(key.keyId)) throw new Error(`duplicate key_id ${key.keyId}`);
    lastRowId += 1;
    keys.set(key.keyId, { ...key, id: lastRowId, revokedAt: null, scopes: [] });
  };
  const keyWrites: KeyWrites = {
    async createApiKey(mint) {
      insert(mint.key);
      append(createAudit(mint));
    },
    async createSelfApiKey(mint) {
      const { key, actor, perSubject } = mint;
      const now = Date.parse(key.createdAt);
      const live = [...keys.values()].filter((k) => k.tenantId === key.tenantId && k.ownerSubject === key.ownerSubject && k.revokedAt === null && now < expiryMs(k.expiresAt));
      const replaced = live.slice(0, Math.max(0, live.length - perSubject + 1));
      insert(key);
      for (const row of replaced) {
        keys.set(row.keyId, { ...row, revokedAt: key.createdAt });
        append({ tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: row.keyId, metadata: { replacedBy: key.keyId } });
      }
      append(createAudit(mint));
      return replaced.map((row) => row.keyId);
    },
    async listApiKeys(query) {
      const nowIso = new Date().toISOString();
      const rows = [...keys.values()].filter((k) => listed(k, query, nowIso)).reverse().map(listRow);
      return query.limit === undefined ? rows : rows.slice(0, query.limit);
    },
  };
  const store: InMemoryKeyWritesStore['store'] = {
    ...portOnlyStoreWithoutVectorReads(hippoRoot),
    kind: 'in-memory',
    async findApiKey(keyId) {
      const key = keys.get(keyId);
      return key ? recordOf(key) : null;
    },
    async appendAuditEvents(events) {
      for (const event of events) append(event);
    },
    keyWrites,
  };
  return { store, auditRows: () => structuredClone(audit) };
}

export const OWNER = 'sso:ann';
export const OWNED_SCOPE = 'private:payroll';

/** Keys OWNER minted for itself, as ids. */
export interface OwnedKeys {
  readonly liveOld: string;
  readonly expired: string;
  readonly revoked: string;
  readonly liveB: string;
  readonly liveNew: string;
}

/** Adds OWNER's keys in both tenants, live, expired and revoked, and an OWNED_SCOPE grant on memberA, to the fixture's template. */
export function seedOwnedKeys(fixture: TwoTenantFixture): OwnedKeys {
  const db = openHippoDb(fixture.dir);
  try {
    const mint = (tenantId: string, label: string, expiresAt: string): string =>
      createApiKey(db, { tenantId, label, role: 'member', ownerSubject: OWNER, expiresAt }).keyId;
    const owned: OwnedKeys = {
      liveOld: mint(TENANT_A, 'old', '2099-01-01T00:00:00.000Z'),
      expired: mint(TENANT_A, 'expired', '2026-02-01T00:00:00.000Z'),
      revoked: mint(TENANT_A, 'revoked', '2099-01-01T00:00:00.000Z'),
      liveB: mint(TENANT_B, 'other-tenant', '2099-01-01T00:00:00.000Z'),
      liveNew: mint(TENANT_A, 'new', '2099-01-01T00:00:00.000Z'),
    };
    revokeApiKey(db, owned.revoked, FIXTURE_REVOKED_AT);
    grantScope(db, fixture.keys.memberA, OWNED_SCOPE);
    return owned;
  } finally {
    closeHippoDb(db);
  }
}
