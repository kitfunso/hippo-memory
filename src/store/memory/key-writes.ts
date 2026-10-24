// The in-memory KeyWrites group and findApiKey's read of the same rows.
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type {
  ApiKeyListRow,
  KeyCalls,
  KeyChangeArgs,
  KeyListQuery,
  KeyMint,
  KeyRevoke,
  KeyWrites,
  NewApiKey,
  ScopeGrantChange,
  SelfKeyMint,
} from '../port/keys.js';
import { assertGrantable, ownedKey } from '../rules/keys.js';
import { byBytes } from '../rules/order.js';
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
  // Stamps compare as text, which toISOString makes correct.
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

function revokeIn(t: MemoryTables, { tenantId, keyId, actor, at }: KeyRevoke): string {
  const key = ownedKey(t.keys.get(keyId), tenantId, keyId);
  if (key.revokedAt) return key.revokedAt;
  appendAudit(t, [{ tenantId: key.tenantId, actor, op: 'auth_revoke', targetId: keyId }]);
  t.keys.set(keyId, { ...key, revokedAt: at });
  return at;
}

function changeGrantIn(t: MemoryTables, { tenantId, keyId, scope, op, actor }: ScopeGrantChange): void {
  const key = ownedKey(t.keys.get(keyId), tenantId, keyId);
  assertGrantable({ op, keyId }, key.revokedAt);
  const others = key.scopes.filter((s) => s !== scope);
  const scopes = op === 'auth_grant' ? [...others, scope].sort(byBytes) : others;
  appendAudit(t, [{ tenantId, actor, op, targetId: keyId, metadata: { scope } }]);
  t.keys.set(keyId, { ...key, scopes });
}

function changeIn(t: MemoryTables, ...[change, input]: KeyChangeArgs): void | string[] | string {
  if (change === 'create') {
    insertKey(t, input.key);
    appendAudit(t, [createAudit(input)]);
    return;
  }
  if (change === 'create_self') return createSelfKeyIn(t, input);
  if (change === 'revoke') return revokeIn(t, input);
  return changeGrantIn(t, input);
}

export function memoryKeyWrites(t: MemoryTables): KeyWrites {
  const keys: KeyCalls = {
    changeApiKey: async (...args) => changeIn(t, ...args),
    listApiKeys: async (query) => listKeysIn(t, query),
  };
  // SAFETY: changeIn answers each change with the value the port's overload for it names.
  return keys as KeyWrites;
}
