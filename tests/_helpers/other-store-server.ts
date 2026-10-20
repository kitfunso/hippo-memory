// Request lines, a stub store and API keys the server-other-store tests share.
import { randomBytes, scryptSync } from 'node:crypto';
import { type McpRequest } from '../../src/mcp/server.js';
import { sqliteStore, type ApiKeyRecord, type HippoStore } from '../../src/entry/store-kit.js';
import { withoutLocalFiles } from '../_helpers/port-only-store.js';
import { V1_ROWS } from '../_helpers/v1-route-rows.js';

/** A V1_ROWS key as a request line, each :param slot filled with 1. */
export const requestLine = (key: string): string => key.replace(/:\w+/g, '1');

/** The entries that need hippo.db's local files, which no store but hippo.db's has. */
export function localFileRoutes(): string[] {
  return V1_ROWS.filter(({ route }) => route.storeReady === 'localFiles' || route.sqliteOnly !== undefined).map(
    ({ key }) => requestLine(key),
  );
}

/** hippo.db's groups, each fenced by serve() for a 'stub' store so a handler reaching one answers 501, without the
 * optional three or the local files. */
export function stubStore(root: string, base: Partial<HippoStore>): HippoStore {
  return {
    ...withoutLocalFiles(sqliteStore(root)),
    kind: 'stub',
    vectorViews: undefined,
    readiness: undefined,
    lastRecall: undefined,
    ...base,
  };
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
