import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifyGitHubSignature, computeIdempotencyKey } from '../src/connectors/github/signature.js';

const SECRET = 'shhh';
const PREVIOUS = 'old-secret';

function sign(body: string, secret: string = SECRET): string {
  const mac = createHmac('sha256', secret).update(body).digest('hex');
  return `sha256=${mac}`;
}

describe('verifyGitHubSignature', () => {
  it('accepts a valid signature with the current secret', () => {
    const body = '{"hello":"world"}';
    const sig = sign(body);
    expect(verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET })).toBe(true);
  });

  it('rejects when the secret is wrong', () => {
    const body = '{"hello":"world"}';
    const sig = sign(body, 'wrong');
    expect(verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET })).toBe(false);
  });

  it('rejects a malformed sha256= prefix', () => {
    const body = '{}';
    const mac = createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyGitHubSignature({ rawBody: body, signature: `sha1=${mac}`, webhookSecret: SECRET })).toBe(false);
  });

  it('rejects on length mismatch (truncated signature)', () => {
    const body = '{}';
    const sig = sign(body).slice(0, 20); // truncated
    expect(verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET })).toBe(false);
  });

  it('accepts under previous-secret rotation', () => {
    const body = '{"rotation":true}';
    const sig = sign(body, PREVIOUS);
    expect(
      verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET, previousSecret: PREVIOUS }),
    ).toBe(true);
  });

  it('rejects a non-hex signature body', () => {
    const body = '{}';
    // Same length as a valid signature ('sha256=' + 64 hex chars) but with non-hex chars.
    const sig = `sha256=${'z'.repeat(64)}`;
    expect(verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET })).toBe(false);
  });

  it('rejects whitespace-padded signatures', () => {
    const body = '{}';
    const sig = ` ${sign(body)} `;
    expect(verifyGitHubSignature({ rawBody: body, signature: sig, webhookSecret: SECRET })).toBe(false);
  });
});

describe('computeIdempotencyKey (codex P0 #3 replay defense)', () => {
  it('produces a different key when eventName differs but body is identical', () => {
    const body = '{"action":"opened","number":1}';
    const keyA = computeIdempotencyKey('issues', body);
    const keyB = computeIdempotencyKey('pull_request', body);
    expect(keyA).not.toBe(keyB);
    // Sanity: same inputs produce the same key.
    expect(computeIdempotencyKey('issues', body)).toBe(keyA);
  });
});
