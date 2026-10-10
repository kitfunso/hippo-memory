import { describe, expect, it } from 'vitest';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { isCrossSite } from '../src/util/http-util.js';

const req = (headers: Record<string, string>): IncomingMessage => Object.assign(new IncomingMessage(new Socket()), { headers });

describe('isCrossSite', () => {
  it('accepts an Origin on the same host under http or https', () => {
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'http://hippo.local:3000' }))).toBe(false);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'https://hippo.local:3000' }))).toBe(false);
  });

  it('refuses another host or port under either scheme, and an opaque origin', () => {
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'https://evil.example' }))).toBe(true);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'http://hippo.local:4000' }))).toBe(true);
    expect(isCrossSite(req({ host: 'hippo.local:3000', origin: 'null' }))).toBe(true);
  });

  it('refuses Sec-Fetch-Site cross-site even with a matching https Origin', () => {
    expect(isCrossSite(req({ host: 'h:1', origin: 'https://h:1', 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });
});
