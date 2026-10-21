// The in-memory KeyWrites group and findApiKey's read of the same rows.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { ApiKeyListRow, KeyListQuery, KeyMint, KeyWrites, NewApiKey, SelfKeyMint } from '../port/key-writes.js';
import type { ApiKeyRecord, AppendAuditOpts } from '../port/types.js';
import { appendAudit, nextId } from './rows.js';
import type { KeyRow, MemoryTables } from './tables.js';

export function apiKeyRecord(t: MemoryTables, keyId: string): ApiKeyRecord | null {
  const key = t.keys.get(keyId);
  if (!key) return null;
  const { keyHash, tenantId, revokedAt, role, scopes, expiresAt, ownerSubject } = key;
  return { keyHash, tenantId, revokedAt, role, scopes: [...scopes], expiresAt, ownerSubject };
}

/** The key check's expiry rule: null never expires, and a stamp that does not parse is already past. */
function expiryMs(expiresAt: string | null): number {
  if (expiresAt === null) return Infinity;
  const ms = Date.parse(expiresAt);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function listed(row: KeyRow, query: KeyListQuery, nowIso: string): boolean {
  if (query.tenantId !== ALL_TENANTS && row.tenantId !== query.tenantId) return false;
  // hippo.db compares the stamps as text, which toISOString makes correct.
  if (query.active && (row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= nowIso))) return false;
  if (query.ownerSubject !== undefined && row.ownerSubject !== query.ownerSubject) return false;
  if (query.keyId !== undefined && row.keyId !== query.keyId) return false;
  if (query.after === undefined) return true;
  const key = Number(query.after.key);
  return row.id < key || (row.id === key && row.id < Number(query.after.id));
}

function listRow(row: KeyRow): ApiKeyListRow {
  const { id, keyId, tenantId, label, createdAt, revokedAt, role, scopes, expiresAt, ownerSubject } = row;
  const key = { keyId, tenantId, label, createdAt, revokedAt, scopes: [...scopes], expiresAt, ownerSubject };
  return { rowId: id, key: { ...key, role: role === 'admin' ? 'admin' : 'member' } };
}

const createAudit = ({ key, actor, metadata }: KeyMint): AppendAuditOpts => ({
  tenantId: key.tenantId,
  actor,
  op: 'auth_create',
  targetId: key.keyId,
  metadata,
});

/** Checked before any change, so a refused insert leaves the store as it was, as a rolled-back transaction does. */
function insertKey(t: MemoryTables, key: NewApiKey): void {
  if (t.keys.has(key.keyId)) throw new Error(`duplicate key_id ${key.keyId}`);
  const id = nextId(t, 'api_keys');
  t.keys.set(key.keyId, { ...key, id, revokedAt: null, scopes: [] });
}

function createSelfKeyIn(t: MemoryTables, mint: SelfKeyMint): string[] {
  const { key, actor, perSubject } = mint;
  const now = Date.parse(key.createdAt);
  const live = [...t.keys.values()]
    .sort((a, b) => a.id - b.id)
    .filter(
      (k) =>
        k.tenantId === key.tenantId &&
        k.ownerSubject === key.ownerSubject &&
        k.revokedAt === null &&
        now < expiryMs(k.expiresAt),
    );
  const replaced = live.slice(0, Math.max(0, live.length - perSubject + 1));
  insertKey(t, key);
  for (const row of replaced) t.keys.set(row.keyId, { ...row, revokedAt: key.createdAt });
  const metadata = { replacedBy: key.keyId };
  const revokes = replaced.map((row): AppendAuditOpts => {
    return { tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: row.keyId, metadata };
  });
  appendAudit(t, [...revokes, createAudit(mint)]);
  return replaced.map((row) => row.keyId);
}

function listKeysIn(t: MemoryTables, query: KeyListQuery): ApiKeyListRow[] {
  const nowIso = new Date().toISOString();
  const rows = [...t.keys.values()]
    .filter((k) => listed(k, query, nowIso))
    .sort((a, b) => b.id - a.id)
    .map(listRow);
  return query.limit === undefined ? rows : rows.slice(0, query.limit);
}

export function memoryKeyWrites(t: MemoryTables): KeyWrites {
  return {
    createApiKey: async (mint) => {
      insertKey(t, mint.key);
      appendAudit(t, [createAudit(mint)]);
    },
    createSelfApiKey: async (mint) => createSelfKeyIn(t, mint),
    listApiKeys: async (query) => listKeysIn(t, query),
  };
}
