/**
 * Pure unit tests for validateOwner (B2 v1.12.6).
 */

import { describe, it, expect } from 'vitest';
import {
  OWNER_RE,
  validateOwner,
  isStrictOwnerEnv,
} from '../src/owner-validation.js';

describe('OWNER_RE', () => {
  it.each([
    'user:alice',
    'user:alice_smith',
    'user:alice-smith',
    'user:Alice123',
    'agent:capture-bot',
    'agent:sleep_consolidator_v2',
    'user:a',
    'agent:1',
  ])('matches valid owner string %s', (owner) => {
    expect(OWNER_RE.test(owner)).toBe(true);
  });

  it.each([
    'alice',                       // no prefix
    'admin:alice',                 // wrong prefix
    'USER:alice',                  // uppercase prefix
    'user:alice@example.com',      // @ not allowed
    'user:alice.smith',            // . not allowed
    'user: alice',                 // space
    'user:',                       // empty id
    ':alice',                      // empty prefix
    'user:alice:extra',            // extra colon
  ])('rejects invalid owner string %s', (owner) => {
    expect(OWNER_RE.test(owner)).toBe(false);
  });
});

describe('validateOwner', () => {
  it('returns ok+undefined when owner is undefined/null/empty', () => {
    for (const v of [undefined, null, ''] as const) {
      const r = validateOwner(v);
      expect(r.ok).toBe(true);
      expect(r.value).toBeUndefined();
      expect(r.message).toBe('');
    }
  });

  it('returns ok+value when owner matches the contract', () => {
    const r = validateOwner('user:alice');
    expect(r.ok).toBe(true);
    expect(r.value).toBe('user:alice');
    expect(r.message).toBe('');
  });

  it('warn-only default: returns ok=true + warning message on bad owner', () => {
    const r = validateOwner('alice', { strict: false });
    expect(r.ok).toBe(true);
    expect(r.value).toBe('alice');
    expect(r.message).toMatch(/\[warn\].*alice.*back-compat/);
  });

  it('warn-only is the default when strict omitted', () => {
    const r = validateOwner('alice');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/\[warn\]/);
  });

  it('strict=true: returns ok=false + error message on bad owner', () => {
    const r = validateOwner('alice', { strict: true });
    expect(r.ok).toBe(false);
    expect(r.value).toBe('alice');
    expect(r.message).toMatch(/Invalid --owner.*alice/);
    expect(r.message).not.toMatch(/back-compat/);
  });
});

describe('isStrictOwnerEnv', () => {
  it('returns true when HIPPO_STRICT_OWNER=1', () => {
    expect(isStrictOwnerEnv({ HIPPO_STRICT_OWNER: '1' })).toBe(true);
  });

  it('returns false when HIPPO_STRICT_OWNER unset', () => {
    expect(isStrictOwnerEnv({})).toBe(false);
  });

  it.each(['0', 'true', 'yes', ''])('returns false for HIPPO_STRICT_OWNER=%s (only 1 enables)', (v) => {
    expect(isStrictOwnerEnv({ HIPPO_STRICT_OWNER: v })).toBe(false);
  });
});
