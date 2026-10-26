// serve() as the CLI on this machine meets it: each request sends the member key the server wrote to its key file.
import type { ServerHandle } from '../../src/server.js';
import { readLocalKey } from '../../src/surface/server/local-key.js';
import { serve as serveSwitched } from './store-switch.js';

/** The 401 a request from this machine with no key gets, pinned word for word since it tells a user where the key is. */
export const KEY_REQUIRED_MESSAGE =
  'auth required: this server takes no request without an API key. Mint one with `hippo auth create` and send it as ' +
  '"Authorization: Bearer <key>"; the hippo CLI reads HIPPO_API_KEY, else the key `hippo serve` wrote to server.key.';

type ServeOptions = Parameters<typeof serveSwitched>[0];

export interface KeyedServer extends ServerHandle {
  readonly key: string;
  /** The Authorization header the key makes, for a test that sends its own request through node:http. */
  readonly auth: { readonly authorization: string };
}

/** Global fetch sends `key` to `handle` unless the call names its own Authorization; stop() puts fetch back. */
export function sendKeyTo(handle: ServerHandle, key: string): KeyedServer {
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
    key,
    auth: { authorization: `Bearer ${key}` },
    stop: async () => {
      globalThis.fetch = realFetch;
      await handle.stop();
    },
  };
}

/** `serve` (the suites' store switch unless a test pins its own) plus the local key it wrote; the per-caller limiter is
 * off unless the test names its own, as every request here comes from the one key. */
export async function serveKeyed(opts: ServeOptions, serve = serveSwitched): Promise<KeyedServer> {
  const handle = await serve({ ...opts, rateLimits: { perCaller: 'off', ...opts.rateLimits } });
  const key = readLocalKey(opts.hippoRoot);
  if (key === undefined) throw new Error(`serve() wrote no key file under ${opts.hippoRoot}`);
  return sendKeyTo(handle, key);
}
