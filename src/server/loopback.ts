// Hosts a bind may name without auth or TLS: the loopback literals, and 'localhost' only if it resolves to loopback.
import { promises as dns } from 'node:dns';
import { errorFields, log } from '../util/log.js';
import { isLoopbackAddress } from '../util/net.js';

/** The resolver for `localhost`; tests hand in a stand-in. */
export type LookupAll = (hostname: string) => Promise<readonly { address: string }[]>;

const resolveAll: LookupAll = (hostname) => dns.lookup(hostname, { all: true });

// A hosts-file line or a resolver can point 'localhost' at a routable address, so the name alone proves nothing.
async function localhostIsLoopback(lookup: LookupAll): Promise<boolean> {
  try {
    const found = await lookup('localhost');
    return found.length > 0 && found.every(({ address }) => isLoopbackAddress(address));
  } catch (err) {
    log.warn("serve: could not resolve 'localhost', so it is not treated as loopback", errorFields(err));
    return false;
  }
}

/** The hosts `serve` treats as loopback for a bind to `host`; the resolver is asked only when `host` is 'localhost'. */
export async function loopbackBindHosts(host: string, lookup: LookupAll = resolveAll): Promise<ReadonlySet<string>> {
  const hosts = new Set(['127.0.0.1', '::1']);
  if (host === 'localhost' && (await localhostIsLoopback(lookup))) hosts.add('localhost');
  return hosts;
}
