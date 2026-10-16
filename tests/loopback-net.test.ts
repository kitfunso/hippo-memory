import { describe, it, expect } from 'vitest';
import { isLoopbackAddress, isLoopbackHost } from '../src/util/net.js';

describe('isLoopbackHost', () => {
  it.each(['localhost', '[::1]', '::1', '127.0.0.1', '127.0.0.2', '127.255.255.254'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });
  it.each(['example.com', '128.0.0.1', '10.0.0.1', '127.0.0.256', '127.0.0', '::ffff:127.0.0.1', ''])(
    'rejects %s',
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe('isLoopbackAddress', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::ffff:127.1.2.3'])('accepts %s', (addr) => {
    expect(isLoopbackAddress(addr)).toBe(true);
  });
  // The expanded '0:0:0:0:0:0:0:1' stays rejected: the helper does not normalise IPv6.
  it.each([
    undefined, '', '192.168.1.1', '10.0.0.1', '8.8.8.8', '::ffff:8.8.8.8', '::ffff:192.168.1.1', 'fe80::1',
    '0:0:0:0:0:0:0:1', 'localhost', '127.0.0.256',
  ])(
    'rejects %s',
    (addr) => {
      expect(isLoopbackAddress(addr)).toBe(false);
    },
  );
});
