// A keyless local caller is always a member, so a test that needs host admin mints a key and sends it.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { resolveTenantId } from '../../src/server/boot.js';

type ServeOpts = Parameters<typeof serve>[0];

export function mintAdminKey(hippoRoot: string): string {
  const db = openHippoDb(hippoRoot);
  try {
    return createApiKey(db, { tenantId: resolveTenantId({}), label: 'test-admin', role: 'admin' }).plaintext;
  } finally {
    closeHippoDb(db);
  }
}

/** serve() plus an admin key that global fetch sends to this server unless the call names its own Authorization. */
export async function serveAsAdmin(opts: ServeOpts): Promise<ServerHandle> {
  // A keyed caller is charged by the per-caller limiter where a keyless one was not, so these runs switch it off.
  const handle = await serve({ rateLimits: { perCaller: 'off' }, ...opts });
  const key = mintAdminKey(opts.hippoRoot);
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(handle.url)) return realFetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has('authorization')) headers.set('authorization', `Bearer ${key}`);
    return realFetch(input, { ...init, headers });
  };
  return {
    ...handle,
    stop: async () => {
      globalThis.fetch = realFetch;
      await handle.stop();
    },
  };
}
