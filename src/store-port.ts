// The async seam the server reaches its store through, so an add-on can serve from a database other than hippo.db.
import { readApiKeyRecord, type ApiKeyRecord } from './auth.js';
import { closeHippoDb, openHippoDb } from './db.js';

/** What `serve()` reads and writes through. Each method is atomic and no transaction spans an await, since SQLite's lock wait blocks the event loop; a lock timeout throws `StoreBusyError`. */
export interface HippoStore {
  /** 'sqlite' is hippo.db under the served root. Under any other kind, an unported route answers 501 and a hippo.db open inside a request throws. */
  readonly kind: string;
  /** The api_keys row for `keyId` with its scope grants, revoked or not; null when no row matches. */
  findApiKey(keyId: string): Promise<ApiKeyRecord | null>;
  /** Releases the store's connections; `serve()` closes only a store it made itself. */
  close(): Promise<void>;
}

/** The built-in store: today's synchronous hippo.db functions behind the port, one handle per call, so close has nothing to release. */
export function sqliteStore(hippoRoot: string): HippoStore {
  return {
    kind: 'sqlite',
    async findApiKey(keyId: string): Promise<ApiKeyRecord | null> {
      const db = openHippoDb(hippoRoot);
      try {
        return readApiKeyRecord(db, keyId);
      } finally {
        closeHippoDb(db);
      }
    },
    async close(): Promise<void> {},
  };
}
