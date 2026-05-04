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

describe('computeIdempotencyKey (codex P0 #3 replay defense + v1.3.1 source-aware fix)', () => {
  it('different artifact_refs produce different keys', () => {
    const k1 = computeIdempotencyKey('github://acme/demo/issue/1', '2026-05-04T10:00:00Z');
    const k2 = computeIdempotencyKey('github://acme/demo/issue/2', '2026-05-04T10:00:00Z');
    expect(k1).not.toBe(k2);
  });

  it('same artifact + same updated_at produces the same key (so backfill and webhook collapse)', () => {
    const ref = 'github://acme/demo/issue/42';
    const ts = '2026-05-04T10:00:00Z';
    expect(computeIdempotencyKey(ref, ts)).toBe(computeIdempotencyKey(ref, ts));
  });

  it('same artifact + different updated_at produces different keys (edit revisions)', () => {
    const ref = 'github://acme/demo/issue/42';
    const k1 = computeIdempotencyKey(ref, '2026-05-04T10:00:00Z');
    const k2 = computeIdempotencyKey(ref, '2026-05-04T11:00:00Z');
    expect(k1).not.toBe(k2);
  });

  it('null and undefined updated_at fold to the same empty-string key', () => {
    const ref = 'github://acme/demo/issue/42';
    expect(computeIdempotencyKey(ref, null)).toBe(computeIdempotencyKey(ref, undefined));
  });
});
