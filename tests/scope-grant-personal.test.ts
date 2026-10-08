// No grant opens a personal scope: granting one is a 400, a grant row already stored opens nothing, and ungrant still clears it (F8).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import * as api from '../src/api.js';
import { createApiKey, grantScope, listScopeGrants } from '../src/auth.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { mapApiError } from '../src/http-util.js';
import { canReadScope } from '../src/recall-scope.js';
import { serve, type ServerHandle } from '../src/server.js';
import { makeRoot } from './_helpers/make-root.js';

const A_SCOPE = 'personal:private:oid-a';
const CONNECTOR_SCOPE = 'slack:private:C1';
const A_TEXT = 'quartzlamp is the alias for my deploy script';

let root: string;
let handle: ServerHandle;
let keyB: { plaintext: string; keyId: string };
let adminCtx: api.Context;

function withDb<T>(fn: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(root);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

function grantsOfB(): string[] {
  return withDb((db) => listScopeGrants(db, keyB.keyId));
}

function recallAs(key: string, scope: string): Promise<Response> {
  return fetch(`${handle.url}/v1/memories?q=quartzlamp&scope=${encodeURIComponent(scope)}`, { headers: { authorization: `Bearer ${key}` } });
}

beforeEach(async () => {
  root = makeRoot('scope-grant-personal', { config: { embeddings: { enabled: false } } });
  keyB = withDb((db) => createApiKey(db, { tenantId: 'default', role: 'member', ownerSubject: 'oid-b' }));
  adminCtx = { hippoRoot: root, tenantId: 'default', actor: api.adminActor('cli') };
  api.remember({ hippoRoot: root, tenantId: 'default', actor: { subject: 'api_key:hk_a', role: 'member', owner: 'oid-a' } }, { content: A_TEXT, personal: true });
  handle = await serve({ hippoRoot: root, port: 0 });
});

afterEach(async () => {
  await handle.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('scope grants and personal scopes', () => {
  it.each([A_SCOPE, 'Personal:private:oid-a', 'personal:anything'])('granting %s is a 400 and stores no grant, while a connector grant still lands', (scope) => {
    let refusal: { status: number; message: string } | undefined;
    try {
      api.authGrant(adminCtx, keyB.keyId, scope);
    } catch (err) {
      refusal = mapApiError(err);
    }
    expect(refusal).toEqual({ status: 400, message: `${scope} is a personal scope: only its owner reads it, and no grant can change that` });
    expect(grantsOfB()).toEqual([]);

    expect(api.authGrant(adminCtx, keyB.keyId, CONNECTOR_SCOPE)).toEqual({ ok: true });
    expect(grantsOfB()).toEqual([CONNECTOR_SCOPE]);
  });

  it('a grant row stored before the refusal opens nothing, a connector grant beside it still does, and ungrant clears it', async () => {
    withDb((db) => grantScope(db, keyB.keyId, A_SCOPE));
    api.authGrant(adminCtx, keyB.keyId, CONNECTOR_SCOPE);

    const personal = await recallAs(keyB.plaintext, A_SCOPE);
    expect(personal.status).toBe(403);
    expect(await personal.text()).not.toContain('quartzlamp is the alias');
    expect((await recallAs(keyB.plaintext, CONNECTOR_SCOPE)).status).toBe(200);

    expect(api.authUngrant(adminCtx, keyB.keyId, A_SCOPE)).toEqual({ ok: true });
    expect(grantsOfB()).toEqual([CONNECTOR_SCOPE]);
  });

  it('a resolver scope list naming a personal scope opens it for nobody but its owner', () => {
    const listed = [A_SCOPE, CONNECTOR_SCOPE];
    const memberB: api.Actor = { subject: 'oidc:b', role: 'member', owner: 'oid-b', scopes: listed, viaAuthResolver: true };
    const adminB: api.Actor = { ...memberB, role: 'admin' };
    const ownerA: api.Actor = { subject: 'oidc:a', role: 'member', owner: 'oid-a', viaAuthResolver: true };
    expect(canReadScope(memberB, A_SCOPE)).toBe(false);
    expect(canReadScope(adminB, A_SCOPE)).toBe(false);
    expect(canReadScope(memberB, CONNECTOR_SCOPE)).toBe(true);
    expect(canReadScope(ownerA, A_SCOPE)).toBe(true);
  });
});
