// hippo.db keeps each row's rejection keys (rejection_digest and held_text_digests), so the key rule is pinned: a
// change here leaves every stored key stale until a migration clears them.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { otherDigests, rejectionDigest } from '../../src/base/records/rejection-digest.js';
import { redactSecretsStrict } from '../../src/base/util/secret-detect.js';
import { mergedText } from '../../src/base/util/same-text.js';
import { ASSIGNED_SECRET_LINES, runtimeJoin } from '../_helpers/secret-shapes.js';

const RULE_CHANGED =
  'the rejection key rule changed: ship a migration that sets rejection_digest to NULL in both tables';

const GHP = runtimeJoin('ghp_', 'x1Y2z3W4v5'.repeat(3), 'Q6r7S8');
const JWT = runtimeJoin('eyJ', 'hbGciOiJIUzI1', '.eyJ', 'zdWIiOiIxMjM0', '.sig', 'nature_part');
const SECRET_LINES = [...ASSIGNED_SECRET_LINES, `token ${GHP}`, `Authorization: Bearer ${JWT}`, JWT];

const short = (digests: readonly string[]): string[] => digests.map((d) => d.slice(0, 12));

describe('the rejection key rule', () => {
  it('keys a plain row by its own digest alone', () => {
    const text = 'The nightly  job runs at TWO';
    expect(rejectionDigest(text).slice(0, 12), RULE_CHANGED).toBe('ea54816817a9');
    expect(rejectionDigest(text), RULE_CHANGED).toBe(rejectionDigest('the nightly job runs at two'));
    expect(otherDigests(text), RULE_CHANGED).toEqual([]);
  });

  it('keys a sleep-merged row by each text it holds', () => {
    const text = mergedText('[Merged 2 related memories]', ['use pnpm here', 'the cache\nlives in /tmp']);
    expect(rejectionDigest(text).slice(0, 12), RULE_CHANGED).toBe('3095aab46c4c');
    expect(short(otherDigests(text)), RULE_CHANGED).toEqual(['1dcb6d63a42a', '7be861096d27']);
    expect(otherDigests(text)).toContain(rejectionDigest('use pnpm here'));
  });

  it('keys an older two-row merge by the one text after its header', () => {
    const text = '[Consolidated from 2 related memories]\n\nkeep the cache warm\n- not a bullet';
    expect(otherDigests(text), RULE_CHANGED).toEqual([rejectionDigest('keep the cache warm\n- not a bullet')]);
  });

  it('keys any markdown list by its bullets, whatever wrote it', () => {
    const text = 'Release steps\n\n- tag the build\n- push the tag';
    expect(short(otherDigests(text)), RULE_CHANGED).toEqual(['00e5a80f2e47', 'ba122791e659']);
    expect(otherDigests(text)).toEqual([rejectionDigest('tag the build'), rejectionDigest('push the tag')].sort());
  });

  it('keys a raw secret row by its stored form and a stored row by itself, for every secret shape', () => {
    const keys = SECRET_LINES.map((raw) => {
      const stored = redactSecretsStrict(raw);
      expect(otherDigests(raw), raw).toEqual([rejectionDigest(stored)]);
      expect(otherDigests(stored), raw).toEqual([]);
      return [rejectionDigest(raw), rejectionDigest(stored)];
    });
    const all = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
    expect(all.slice(0, 12), RULE_CHANGED).toBe('f522fea335ab');
  });
});
