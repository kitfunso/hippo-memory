// The key cases: findApiKey and every keyWrites change and listing.
import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../base/errors/api-errors.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import type { NewApiKey } from '../../base/ports/store/keys.js';
import { ACTOR, AT, OTHER_TENANT, TENANT, failureOf, type Check } from './kit.js';

const LATER = '2026-03-01T13:00:00.000Z';
const EXPIRES = '2099-01-01T00:00:00.000Z';

function newKey(tenantId: string, over: Partial<NewApiKey> = {}): NewApiKey {
  return {
    keyId: `hk_conformance${randomUUID().replaceAll('-', '')}`,
    keyHash: 'conformance-hash',
    tenantId,
    label: null,
    role: 'member',
    createdAt: AT,
    ownerSubject: null,
    expiresAt: null,
    ...over,
  };
}

async function mint(store: HippoStore, key: NewApiKey): Promise<NewApiKey> {
  await store.keyWrites.changeApiKey('create', { key, actor: ACTOR, metadata: {} });
  return key;
}

function revoke(store: HippoStore, tenantId: string, keyId: string, at: string) {
  return store.keyWrites.changeApiKey('revoke', { tenantId, keyId, actor: ACTOR, at });
}

/** A self-service key of `owner`, which keeps at most one live key. */
function mintSelf(store: HippoStore, owner: string) {
  const key = { ...newKey(TENANT), ownerSubject: owner, expiresAt: EXPIRES };
  return store.keyWrites
    .changeApiKey('create_self', { key, actor: ACTOR, metadata: {}, perSubject: 1 })
    .then((revoked) => ({ keyId: key.keyId, revoked }));
}

const readsMinted: Check = async (store, expect) => {
  const key = await mint(store, newKey(TENANT));
  const found = await store.findApiKey(key.keyId);
  expect(found?.tenantId).toBe(TENANT);
  expect(found?.revokedAt).toBe(null);
  expect(await store.findApiKey('hk_conformance_never_minted')).toBe(null);
};

const revokesOnce: Check = async (store, expect) => {
  const key = await mint(store, newKey(TENANT));
  expect(await revoke(store, TENANT, key.keyId, AT)).toBe(AT);
  expect(await revoke(store, TENANT, key.keyId, LATER)).toBe(AT);
  expect((await store.findApiKey(key.keyId))?.revokedAt).toBe(AT);
};

const fencesTenants: Check = async (store, expect) => {
  const key = await mint(store, newKey(OTHER_TENANT));
  const failure = await failureOf(() => revoke(store, TENANT, key.keyId, AT));
  expect(failure).toBe(`${NotFoundError.name}: Unknown key_id: ${key.keyId}`);
  expect((await store.findApiKey(key.keyId))?.revokedAt).toBe(null);
};

const capsSelfService: Check = async (store, expect) => {
  const first = await mintSelf(store, 'user:alice');
  const second = await mintSelf(store, 'user:alice');
  expect([first.revoked, second.revoked]).toEqual([[], [first.keyId]]);
  expect((await store.findApiKey(first.keyId))?.revokedAt === null).toBe(false);
  expect((await store.findApiKey(second.keyId))?.ownerSubject).toBe('user:alice');
};

const grantsScopes: Check = async (store, expect) => {
  const { keyId } = await mint(store, newKey(TENANT));
  const scope = (op: 'auth_grant' | 'auth_ungrant') =>
    store.keyWrites.changeApiKey('scope', {
      tenantId: TENANT,
      keyId,
      scope: 'team:ops',
      op,
      actor: ACTOR,
    });
  await scope('auth_grant');
  expect((await store.findApiKey(keyId))?.scopes).toEqual(['team:ops']);
  await scope('auth_ungrant');
  expect((await store.findApiKey(keyId))?.scopes).toEqual([]);
};

const listsNewestFirst: Check = async (store, expect) => {
  const older = await mint(store, newKey(TENANT));
  const newer = await mint(store, newKey(TENANT));
  await mint(store, newKey(OTHER_TENANT));
  await revoke(store, TENANT, older.keyId, AT);
  const listed = async (active: boolean) =>
    (await store.keyWrites.listApiKeys({ active, tenantId: TENANT })).map((row) => row.key.keyId);
  expect(await listed(false)).toEqual([newer.keyId, older.keyId]);
  expect(await listed(true)).toEqual([newer.keyId]);
};

export const KEY_CHECKS = {
  'reads a minted key back under its tenant, live, and answers null for an unknown id': readsMinted,
  'revokes at the given time and keeps that first time on a second revoke': revokesOnce,
  "answers another tenant's key as unknown and leaves it live": fencesTenants,
  "revokes an owner's older self-service key past its limit and names it": capsSelfService,
  'grants a scope to a key and takes it back': grantsScopes,
  "lists a tenant's keys newest first, and only the live ones when asked": listsNewestFirst,
} satisfies Readonly<Record<string, Check>>;
