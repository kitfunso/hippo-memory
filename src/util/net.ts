// Two loopback rules for two inputs: a URL hostname and a socket's remote address.

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAPPED_PREFIX = '::ffff:';

/** A URL hostname that stays on this machine: localhost, ::1 (bracketed or not) or any 127.0.0.0/8 address. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || IPV4_LOOPBACK.test(hostname);
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
