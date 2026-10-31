// Request lines, a stub store and API keys the server-other-store tests share.
import { randomBytes, scryptSync } from 'node:crypto';
import { type McpRequest } from '../../src/surface/mcp/server.js';
import { sqliteStore, type ApiKeyRecord, type HippoStore } from '../../src/entry/store-kit.js';
import { withoutHippoDb } from './port-only-store.js';
import { V1_ROWS } from './v1-route-rows.js';

/** A V1_ROWS key as a request line, each :param slot filled with 1. */
export const requestLine = (key: string): string => key.replace(/:\w+/g, '1');

/** The entries that need hippo.db's local tier, which no store but hippo.db's has: its rows and the
 * webhooks, whose connector writes live there. */
export function localFileRoutes(): string[] {
  return V1_ROWS.filter(({ route }) => route.hippoDb === true || route.auth === 'webhook-signature').map(({ key }) =>
    requestLine(key),
  );
}

/** hippo.db's core groups under a 'stub' kind, without its local tier. */
export function stubStore(root: string, base: Partial<HippoStore>): HippoStore {
  const stub = {
    ...withoutHippoDb(sqliteStore(root)),
    kind: 'stub',
    ...base,
  };
  return stub;
}

export const rpc = (method: string, params?: McpRequest['params']): string =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const base32 = (n: number): string => Array.from(randomBytes(n), (b) => BASE32[b % 32]).join('');

export interface TestKey {
  keyId: string;
  plaintext: string;
  record: ApiKeyRecord;
}

export function newKey(): TestKey {
  const keyId = `hk_${base32(24)}`;
  const plaintext = `${keyId}.${base32(32)}`;
  const salt = randomBytes(16);
  const keyHash = `scrypt$${salt.toString('hex')}$${scryptSync(plaintext, salt, 32).toString('hex')}`;
  return {
    keyId,
    plaintext,
    record: { keyHash, tenantId: 'default', revokedAt: null, role: 'member', scopes: [], expiresAt: null },
  };
}

export const bearer = (key: TestKey) => ({ authorization: `Bearer ${key.plaintext}` });
