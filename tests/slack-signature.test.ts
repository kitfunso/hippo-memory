import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifySlackSignature } from '../src/connectors/slack/signature.js';

const SECRET = 'shhh';

function sign(ts: string, body: string): string {
  const mac = createHmac('sha256', SECRET).update(`v0:${ts}:${body}`).digest('hex');
  return `v0=${mac}`;
}

describe('verifySlackSignature', () => {
  const now = Math.floor(Date.now() / 1000);

  it('accepts a valid signature within the 5min window', () => {
    const body = '{"hello":"world"}';
    const ts = String(now);
    const sig = sign(ts, body);
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature: sig, signingSecret: SECRET, now })).toBe(true);
  });

  it('rejects a tampered body', () => {
    const ts = String(now);
    const sig = sign(ts, '{"hello":"world"}');
    expect(verifySlackSignature({ rawBody: '{"hello":"evil"}', timestamp: ts, signature: sig, signingSecret: SECRET, now })).toBe(false);
  });

  it('rejects a stale timestamp (>5min skew)', () => {
    const stale = String(now - 6 * 60);
    const body = '{}';
    const sig = sign(stale, body);
    expect(verifySlackSignature({ rawBody: body, timestamp: stale, signature: sig, signingSecret: SECRET, now })).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySlackSignature({ rawBody: '{}', timestamp: String(now), signature: 'garbage', signingSecret: SECRET, now })).toBe(false);
  });
});
