import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { isWellFormedSlackRequest, verifySlackSignature } from '../../src/surface/connectors/slack/signature.js';

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
    expect(verifySlackSignature({ rawBody: body, timestamp: ts, signature: sig, signingSecret: SECRET, now })).toBe(
      true,
    );
  });

  it('rejects a tampered body', () => {
    const ts = String(now);
    const sig = sign(ts, '{"hello":"world"}');
    expect(
      verifySlackSignature({ rawBody: '{"hello":"evil"}', timestamp: ts, signature: sig, signingSecret: SECRET, now }),
    ).toBe(false);
  });

  it('rejects a stale timestamp (>5min skew)', () => {
    const stale = String(now - 6 * 60);
    const body = '{}';
    const sig = sign(stale, body);
    expect(verifySlackSignature({ rawBody: body, timestamp: stale, signature: sig, signingSecret: SECRET, now })).toBe(
      false,
    );
  });

  it('rejects a malformed signature header', () => {
    expect(
      verifySlackSignature({ rawBody: '{}', timestamp: String(now), signature: 'garbage', signingSecret: SECRET, now }),
    ).toBe(false);
  });
});

describe('isWellFormedSlackRequest', () => {
  const now = 1_800_000_000;
  const digest = 'a1'.repeat(32);

  it('passes a v0= signature of 64 hex digits with a timestamp inside the skew window', () => {
    expect(isWellFormedSlackRequest(String(now), `v0=${digest}`, now)).toBe(true);
    expect(isWellFormedSlackRequest(String(now - 300), `v0=${digest}`, now)).toBe(true);
    expect(isWellFormedSlackRequest(String(now + 300), `v0=${digest}`, now)).toBe(true);
  });

  it('refuses a timestamp outside the window, in the past or the future, and one that is no number', () => {
    for (const timestamp of [String(now - 301), String(now + 301), '1', '', 'soon', 'NaN']) {
      expect(isWellFormedSlackRequest(timestamp, `v0=${digest}`, now), timestamp).toBe(false);
    }
  });

  it('refuses a signature that is not v0= plus 64 lowercase hex digits', () => {
    const bad = [
      'v0=00',
      'v1=' + digest,
      digest,
      `v0=${digest}0`,
      `v0=${'g'.repeat(64)}`,
      `v0=${digest.toUpperCase()}`,
      '',
    ];
    for (const signature of bad) expect(isWellFormedSlackRequest(String(now), signature, now), signature).toBe(false);
  });

  it('agrees with verifySlackSignature: a signature it passes is one the verifier can accept', () => {
    const ts = String(now);
    const sig = sign(ts, '{}');
    expect(isWellFormedSlackRequest(ts, sig, now)).toBe(true);
    expect(verifySlackSignature({ rawBody: '{}', timestamp: ts, signature: sig, signingSecret: SECRET, now })).toBe(
      true,
    );
  });
});
