import { describe, expect, it } from 'vitest';
import { fnv1a32 } from '../../src/base/util/fnv1a.js';
import { hashQueryText } from '../../src/api/recall/anchoring.js';

describe('fnv1a32', () => {
  it('matches the published 32-bit FNV-1a vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  // A vector graph file stores these hashes and recall history stores the query hash, so both stay as written.
  it('keeps the values a graph file and the recall history already hold', () => {
    expect(fnv1a32('mem_01HZX3K9Q2V7')).toBe(2159792539);
    expect(hashQueryText('login bug')).toBe(1052063460);
    expect(hashQueryText('bug login login')).toBe(1052063460);
  });

  it('hashes UTF-16 code units, so a lone surrogate and a CJK string hash without throwing', () => {
    expect(fnv1a32('\uD800')).toBe(fnv1a32('\uD800'));
    expect(fnv1a32('日本語')).not.toBe(fnv1a32('日本'));
  });
});
