// The local key is a member key, so a test that needs host admin mints an admin key and sends it.
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import type { ServerHandle } from '../../src/server.js';
import { serve } from './store-switch.js';
import { sendKeyTo } from './keyed-server.js';
import { createApiKey } from '../../src/store/sqlite/auth.js';
import { resolveTenantId } from '../../src/surface/server/boot.js';

type ServeOptions = Parameters<typeof serve>[0];

export function mintAdminKey(hippoRoot: string): string {
  const db = openHippoDb(hippoRoot);
  try {
    return createApiKey(db, { tenantId: resolveTenantId({}), label: 'test-admin', role: 'admin' })
      .plaintext;
  } finally {
    closeHippoDb(db);
  }
}

/** serve() plus an admin key that global fetch sends to this server unless the call names its own Authorization. */
export async function serveAsAdmin(opts: ServeOptions): Promise<ServerHandle> {
  // Minted before the boot so the served store holds the key.
  const key = mintAdminKey(opts.hippoRoot);
  // Every request sends the one key, so the per-caller limiter is off.
  const handle = await serve({ rateLimits: { perCaller: 'off' }, ...opts });
  return sendKeyTo(handle, key);
}
