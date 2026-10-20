// 'localhost' counts as loopback for the auth and TLS checks of a bind only when the resolver says every address of it is.
import { promises as dns } from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serve, type ServerHandle } from '../../src/server.js';
import { type LookupAll, loopbackBindHosts } from '../../src/surface/server/loopback.js';
import { makeStore } from '../_helpers/make-root.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const answering =
  (...addresses: string[]): LookupAll =>
  async () =>
    addresses.map((address) => ({ address }));

describe('loopbackBindHosts', () => {
  it('adds localhost when every address it resolves to is loopback', async () => {
    const hosts = await loopbackBindHosts('localhost', answering('127.0.0.1', '::1', '::ffff:127.0.0.1'));
    expect([...hosts].sort()).toEqual(['127.0.0.1', '::1', 'localhost']);
  });

  it('leaves localhost out when any address it resolves to is not loopback', async () => {
    expect(await loopbackBindHosts('localhost', answering('127.0.0.1', '10.0.0.5'))).not.toContain('localhost');
    expect(await loopbackBindHosts('localhost', answering('192.168.1.20'))).not.toContain('localhost');
  });

  it('leaves localhost out when it resolves to nothing or the lookup fails', async () => {
    expect(await loopbackBindHosts('localhost', answering())).not.toContain('localhost');
    const failing: LookupAll = async () => {
      throw new Error('getaddrinfo ENOTFOUND localhost');
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await loopbackBindHosts('localhost', failing)).not.toContain('localhost');
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('errorClass=Error');
  });

  it('asks the resolver only for localhost', async () => {
    const lookup = vi.fn(answering('10.0.0.5'));
    expect([...(await loopbackBindHosts('0.0.0.0', lookup))].sort()).toEqual(['127.0.0.1', '::1']);
    expect(await loopbackBindHosts('127.0.0.1', lookup)).toContain('127.0.0.1');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('serve() bound to localhost', () => {
  let hippoRoot: string;
  let handle: ServerHandle | undefined;

  beforeEach(() => {
    hippoRoot = makeStore('localhost-lookup').root;
    vi.stubEnv('HIPPO_REQUIRE_AUTH', undefined);
    vi.stubEnv('HIPPO_ALLOW_CLEARTEXT', undefined);
  });

  afterEach(async () => {
    await handle?.stop();
    handle = undefined;
  });

  /** Makes the resolver answer `addresses` for every name. */
  function resolveEverythingTo(...addresses: string[]): void {
    const answer = addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    // vi.fn() is loosely typed, which spyOn needs here: it sees the overload that answers one address, not a list.
    vi.spyOn(dns, 'lookup').mockImplementation(vi.fn().mockResolvedValue(answer));
  }

  it('refuses the bind without auth when localhost resolves to a routable address', async () => {
    resolveEverythingTo('10.0.0.5');
    await expect(serve({ hippoRoot, host: 'localhost', port: 0 })).rejects.toThrow(/Refusing to bind hippo serve/);
  });

  it('asks for TLS once auth is on and localhost resolves to a routable address', async () => {
    resolveEverythingTo('10.0.0.5');
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    await expect(serve({ hippoRoot, host: 'localhost', port: 0 })).rejects.toMatchObject({
      name: 'CleartextBindError',
    });
  });

  it('boots without auth or TLS when localhost resolves to loopback only', async () => {
    resolveEverythingTo('127.0.0.1', '::1');
    handle = await serve({ hippoRoot, host: 'localhost', port: 0 });
    const res = await fetch(`http://localhost:${handle.port}/health`);
    expect(res.status).toBe(200);
  });
});
