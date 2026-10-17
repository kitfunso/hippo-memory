// Loopback rules for a URL hostname and a socket remote address, and the outbound URL rule built on the first.

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAPPED_PREFIX = '::ffff:';

/** A URL hostname that stays on this machine: localhost, ::1 (bracketed or not) or any 127.0.0.0/8 address. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || IPV4_LOOPBACK.test(hostname);
}

/** An endpoint that gets a key or memory text: https, or http only to this machine, and no userinfo, which fetch echoes
 * in its error text. Throws naming `setting`, and `keySetting` as the home for a credential. */
export function parseOutboundUrl(raw: string, setting: string, keySetting?: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${setting} is not a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${setting} must be an http or https URL`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${setting} must not embed credentials${keySetting ? `; set ${keySetting}` : ''}`);
  }
  // Plain http would put the key and the memory text on the wire, so only the local machine may use it.
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${setting} must use https unless it is on this machine`);
  }
  return parsed;
}

/** A socket remote address on this machine; Node reports a dual-stack IPv4 peer as '::ffff:127.x.x.x'. */
export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  if (remoteAddress === '::1') return true;
  const plain = remoteAddress.toLowerCase().startsWith(MAPPED_PREFIX)
    ? remoteAddress.slice(MAPPED_PREFIX.length)
    : remoteAddress;
  return IPV4_LOOPBACK.test(plain);
}
