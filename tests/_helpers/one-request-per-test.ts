// A test run as one request, as a CLI command or an HTTP call runs: its store calls share one handle per store, so it
// pays one connection's open and close-time checkpoint, not one per call.
import { rmSync } from 'node:fs';
import { aroundEach } from 'vitest';
import * as srcStores from '../../src/db/index.js';

/** The request-scope pair of one build of the store module: src, or dist for code such as benchmarks/ that loads dist. */
export interface StoreScopes {
  withSharedStoreHandles<T>(fn: () => T | Promise<T>): Promise<T>;
  currentRequestStores(): { close(): void } | undefined;
}

/** Runs each test of the calling file, with its beforeEach and afterEach hooks, in one request scope. */
export function oneRequestPerTest(stores: StoreScopes = srcStores): void {
  aroundEach((runTest) => stores.withSharedStoreHandles(runTest));
}

/** Ends the request this code runs in, closing its store handles, then removes `dir`: Windows refuses to delete a store
 *  whose handle is open. Later store calls in the test open their own connections. */
export function removeAfterRequest(dir: string, stores: StoreScopes = srcStores): void {
  stores.currentRequestStores()?.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
