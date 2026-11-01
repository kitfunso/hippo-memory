// The store-kit suite an add-on runs against its own HippoStore. It takes the test runner's
// describe, it and expect, so the package imports no test framework.
import { NotFoundError } from '../base/errors/api-errors.js';
import type { HippoStore } from '../base/ports/store-index.js';

interface Expectation<T> {
  toBe(expected: T): void;
}

/** The three functions of vitest, jest or node:test that the suite registers its checks with. */
export interface ConformanceRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
  expect<T>(actual: T): Expectation<T>;
}

const AT = '2026-03-01T12:00:00.000Z';
const LATER = '2026-03-01T13:00:00.000Z';

let minted = 0;

function newKey(tenantId: string) {
  minted += 1;
  return {
    keyId: `hk_conformance${minted}`,
    keyHash: 'conformance-hash',
    tenantId,
    label: null,
    role: 'member' as const,
    createdAt: AT,
    ownerSubject: null,
    expiresAt: null,
  };
}

async function withStore(
  open: () => Promise<HippoStore> | HippoStore,
  run: (store: HippoStore) => Promise<void>,
) {
  const store = await open();
  try {
    await run(store);
  } finally {
    await store.close();
  }
}

async function failureOf<R>(run: () => Promise<R>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? `${err.name}: ${err.message}` : undefined;
  }
  return undefined;
}

function revoke(
  store: HippoStore,
  { tenantId, keyId, at }: { tenantId: string; keyId: string; at: string },
) {
  return store.keyWrites.changeApiKey('revoke', { tenantId, keyId, actor: 'conformance', at });
}

/** Registers the checks every store must pass on its required groups; `open` gives a fresh,
 * empty store for each. */
export function runStoreConformance(
  runner: ConformanceRunner,
  open: () => Promise<HippoStore> | HippoStore,
): void {
  const { describe, it, expect } = runner;

  describe('store conformance: key writes', () => {
    it('reads a minted key back under its tenant, live', () =>
      withStore(open, async (store) => {
        const key = newKey('acme');
        await store.keyWrites.changeApiKey('create', { key, actor: 'conformance', metadata: {} });
        const found = await store.findApiKey(key.keyId);
        expect(found?.tenantId).toBe('acme');
        expect(found?.revokedAt).toBe(null);
      }));

    it('revokes at the given time and keeps that first time on a second revoke', () =>
      withStore(open, async (store) => {
        const key = newKey('acme');
        await store.keyWrites.changeApiKey('create', { key, actor: 'conformance', metadata: {} });
        expect(await revoke(store, { tenantId: 'acme', keyId: key.keyId, at: AT })).toBe(AT);
        expect(await revoke(store, { tenantId: 'acme', keyId: key.keyId, at: LATER })).toBe(AT);
        expect((await store.findApiKey(key.keyId))?.revokedAt).toBe(AT);
      }));

    it("answers another tenant's key as unknown and leaves it live", () =>
      withStore(open, async (store) => {
        const key = newKey('globex');
        await store.keyWrites.changeApiKey('create', { key, actor: 'conformance', metadata: {} });
        const failure = await failureOf(() =>
          revoke(store, { tenantId: 'acme', keyId: key.keyId, at: AT }),
        );
        expect(failure).toBe(`${NotFoundError.name}: Unknown key_id: ${key.keyId}`);
        expect((await store.findApiKey(key.keyId))?.revokedAt).toBe(null);
      }));
  });
}
