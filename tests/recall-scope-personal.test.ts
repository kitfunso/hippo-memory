// Personal scopes answer to their owner alone, and an HttpError can carry Retry-After.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BadRequestError } from '../src/core/api-errors.js';
import { HttpError, MAX_ID_LEN } from '../src/util/http-util.js';
import {
  assertClientScope, assertScopeRequestAllowed, canReadScope, canTouchScope, isPersonalScope, passesCliRecallScopeFilter,
  passesScopeFilterForRecall, PERSONAL_OWNER_MAX, personalScopeOf, ScopeForbiddenError, type ScopeActor,
} from '../src/core/recall-scope.js';
import { serve, type ServerHandle } from '../src/server.js';
import { initStore } from '../src/store/open.js';

const A_SCOPE = 'personal:private:a';
const B_SCOPE = 'personal:private:b';
const SLACK = 'slack:private:C1';

const ownerA: ScopeActor = { role: 'member', owner: 'a' };
const ownerB: ScopeActor = { role: 'member', owner: 'b' };
const unownedAdmin: ScopeActor = { role: 'admin' };
const ownedAdmin: ScopeActor = { role: 'admin', owner: 'adm' };

describe('canReadScope decides a personal scope before role and grants', () => {
  it('opens a personal scope to its owner only', () => {
    expect(canReadScope(ownerA, A_SCOPE)).toBe(true);
    expect(canReadScope(ownerB, A_SCOPE)).toBe(false);
    expect(canReadScope(unownedAdmin, A_SCOPE)).toBe(false);
    expect(canReadScope(ownedAdmin, 'personal:private:adm')).toBe(true);
    expect(canReadScope(ownedAdmin, A_SCOPE)).toBe(false);
    expect(canReadScope({ role: 'member', owner: 'b', scopes: [A_SCOPE] }, A_SCOPE)).toBe(false);
    expect(canReadScope(ownerA, 'Personal:private:a')).toBe(false);
  });

  it('leaves connector scopes on today\'s rule', () => {
    expect(canReadScope({ role: 'member', scopes: [SLACK] }, SLACK)).toBe(true);
    expect(canReadScope(ownerA, SLACK)).toBe(false);
    expect(canReadScope(unownedAdmin, SLACK)).toBe(true);
  });

  it('a request for another person\'s scope is a 403', () => {
    expect(() => assertScopeRequestAllowed(ownerB, A_SCOPE)).toThrow(ScopeForbiddenError);
    expect(() => assertScopeRequestAllowed(ownerA, A_SCOPE)).not.toThrow();
  });
});

describe('personalScopeOf', () => {
  it('fits the owner cap to the 256-character scope cap', () => {
    expect(PERSONAL_OWNER_MAX).toBe(239);
    const longest = 'x'.repeat(239);
    expect(personalScopeOf({ owner: longest })).toBe(`personal:private:${longest}`);
    expect(personalScopeOf({ owner: longest })?.length).toBe(MAX_ID_LEN);
    expect(personalScopeOf({ owner: 'x'.repeat(240) })).toBeNull();
  });

  it('gives no scope for no owner, an empty one, or a control character', () => {
    expect(personalScopeOf({ owner: '' })).toBeNull();
    expect(personalScopeOf({ owner: 'a\tb' })).toBeNull();
    expect(personalScopeOf({})).toBeNull();
    expect(personalScopeOf(undefined)).toBeNull();
  });
});

describe('assertClientScope, isPersonalScope and canTouchScope', () => {
  it('refuses a client personal: scope in any case with a 400', () => {
    for (const scope of ['personal:x', 'Personal:private:a']) {
      expect(() => assertClientScope(scope), scope).toThrow(BadRequestError);
    }
    for (const scope of ['team', SLACK, null, undefined]) expect(() => assertClientScope(scope)).not.toThrow();
  });

  it('spots personal:private: in any case only', () => {
    expect(isPersonalScope('PERSONAL:PRIVATE:a')).toBe(true);
    expect(isPersonalScope('personal:x')).toBe(false);
    expect(isPersonalScope(null)).toBe(false);
  });

  it('lets anyone touch a non-personal row and only the owner a personal one', () => {
    expect(canTouchScope(ownerA, A_SCOPE)).toBe(true);
    expect(canTouchScope(ownerB, A_SCOPE)).toBe(false);
    expect(canTouchScope({}, A_SCOPE)).toBe(false);
    expect(canTouchScope({}, 'team')).toBe(true);
    expect(canTouchScope({}, null)).toBe(true);
  });
});

describe('recall filters', () => {
  it('admits the caller\'s own personal scope on an empty request, and nobody else\'s', () => {
    expect(passesScopeFilterForRecall(A_SCOPE, undefined)).toBe(false);
    expect(passesScopeFilterForRecall(A_SCOPE, undefined, A_SCOPE)).toBe(true);
    expect(passesScopeFilterForRecall(B_SCOPE, '', A_SCOPE)).toBe(false);
    expect(passesScopeFilterForRecall(SLACK, undefined, A_SCOPE)).toBe(false);
    expect(passesScopeFilterForRecall(A_SCOPE, 'team', A_SCOPE)).toBe(false);
  });

  it('the CLI never unlocks a named personal scope, and still unlocks a named connector scope', () => {
    expect(passesCliRecallScopeFilter(A_SCOPE, A_SCOPE)).toBe(false);
    expect(passesCliRecallScopeFilter('PERSONAL:private:a', 'PERSONAL:private:a')).toBe(false);
    expect(passesCliRecallScopeFilter(SLACK, SLACK)).toBe(true);
  });
});

describe('HttpError Retry-After', () => {
  let root: string;
  let handle: ServerHandle;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'hippo-retry-after-'));
    initStore(root);
    handle = await serve({
      hippoRoot: root, host: '127.0.0.1', port: 0, routes: [
        { path: '/v1/x-slow', handler: async () => { throw new HttpError(429, 'slow down', 7); } },
        { path: '/v1/x-gone', handler: async () => { throw new HttpError(404, 'gone'); } },
      ],
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function post(path: string): Promise<Response> {
    return fetch(`${handle.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  }

  it('a 429 that carries a retry value sends it as Retry-After', async () => {
    const res = await post('/v1/x-slow');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(await res.json()).toEqual({ error: 'slow down' });
  });

  it('an HttpError without one sends no Retry-After', async () => {
    const res = await post('/v1/x-gone');
    expect(res.status).toBe(404);
    expect(res.headers.get('retry-after')).toBeNull();
    expect(new HttpError(404, 'gone').retryAfterSec).toBeUndefined();
  });
});
