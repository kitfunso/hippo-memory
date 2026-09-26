import { describe, it, expect } from 'vitest';
import {
  contentTokens,
  promptTokens,
  scoreOverlap,
  gatePromptRecall,
  promptRecallFtsQuery,
  rarestPromptTerms,
  RAREST_TERM_COUNT,
  PROMPT_RECALL_MAX_CHARS,
  type PromptRecallGate,
} from '../src/prompt-recall.js';

function cand(id: string, tokens: string[]) {
  return { id, tokens: new Set(tokens) };
}

const gate = (over: Partial<PromptRecallGate> = {}): PromptRecallGate => ({
  metric: 'jaccard',
  threshold: 0.2,
  minShared: 2,
  maxItems: 3,
  ...over,
});

describe('contentTokens / promptTokens', () => {
  it('drops stop words and tokens of length <= 2', () => {
    const toks = contentTokens('the api is a sql and or up to'); // "up"/"to"/"an" are length <= 2 or stop words; "db" itself is length 2 so excluded too
    expect([...toks]).toEqual(['api', 'sql']);
  });

  it('keeps a token that ends exactly at the cut', () => {
    const pad = 'a '.repeat((PROMPT_RECALL_MAX_CHARS - 4) / 2) + 'zulu'; // pad ends in a space, then a 4-char word up to the cut
    const toks = promptTokens(pad);
    expect(toks.has('zulu')).toBe(true);
  });

  it('ignores a token that only appears after char 4000', () => {
    const pad = 'a '.repeat(PROMPT_RECALL_MAX_CHARS / 2); // exactly 4000 chars, ends on a space
    const toks = promptTokens(pad + 'unique');
    expect(toks.has('unique')).toBe(false);
  });
});

describe('scoreOverlap', () => {
  it('scores 0 when either set is empty', () => {
    expect(scoreOverlap(new Set(), new Set(['a']), 'jaccard')).toEqual({ score: 0, shared: 0 });
    expect(scoreOverlap(new Set(['a']), new Set(), 'cosine')).toEqual({ score: 0, shared: 0 });
  });

  it('computes jaccard = shared / (|P| + |M| - shared)', () => {
    const p = new Set(['a', 'b', 'c']);
    const m = new Set(['b', 'c', 'd']);
    const { score, shared } = scoreOverlap(p, m, 'jaccard');
    expect(shared).toBe(2);
    expect(score).toBeCloseTo(2 / 4, 10);
  });

  it('computes cosine = shared / sqrt(|P| * |M|)', () => {
    const p = new Set(['a', 'b', 'c']);
    const m = new Set(['b', 'c', 'd', 'e']);
    const { score, shared } = scoreOverlap(p, m, 'cosine');
    expect(shared).toBe(2);
    expect(score).toBeCloseTo(2 / Math.sqrt(3 * 4), 10);
  });

  it('iterates the smaller set (order-independent result)', () => {
    const p = new Set(['a']);
    const m = new Set(['a', 'b', 'c', 'd', 'e']);
    expect(scoreOverlap(p, m, 'jaccard')).toEqual(scoreOverlap(m, p, 'jaccard'));
  });
});

describe('gatePromptRecall', () => {
  it('returns [] for an empty prompt set', () => {
    const out = gatePromptRecall(new Set(), [cand('a', ['x', 'y'])], gate());
    expect(out).toEqual([]);
  });

  it('keeps only candidates at or above the threshold (inclusive boundary)', () => {
    const p = new Set(['a', 'b', 'c', 'd']); // size 4
    // shared=2 over |P|=4,|M|=4 -> jaccard = 2/6 = 0.3333, above 0.2
    const atThreshold = cand('exact', ['a', 'b', 'x', 'y']);
    const g = gate({ threshold: 2 / 6, minShared: 2 });
    const out = gatePromptRecall(p, [atThreshold], g);
    expect(out).toHaveLength(1);
    expect(out[0].item.id).toBe('exact');
  });

  it('drops a candidate just below the threshold', () => {
    const p = new Set(['a', 'b', 'c', 'd']);
    const belowThreshold = cand('close', ['a', 'b', 'x', 'y']);
    const g = gate({ threshold: 2 / 6 + 0.001, minShared: 2 });
    expect(gatePromptRecall(p, [belowThreshold], g)).toEqual([]);
  });

  it('enforces minShared inclusively', () => {
    const p = new Set(['a', 'b', 'c']);
    const twoShared = cand('two', ['a', 'b', 'z']);
    const g = gate({ metric: 'jaccard', threshold: 0, minShared: 2 });
    expect(gatePromptRecall(p, [twoShared], g)).toHaveLength(1);
    expect(gatePromptRecall(p, [twoShared], { ...g, minShared: 3 })).toEqual([]);
  });

  it('caps results at maxItems after sorting by score desc', () => {
    const p = new Set(['a', 'b', 'c', 'd', 'e']);
    const items = [
      cand('low', ['a', 'b', 'z', 'z2']),
      cand('mid', ['a', 'b', 'c', 'z']),
      cand('high', ['a', 'b', 'c', 'd']),
      cand('extra', ['a', 'b', 'c', 'd', 'e']),
    ];
    const g = gate({ threshold: 0, minShared: 2, maxItems: 2 });
    const out = gatePromptRecall(p, items, g);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.item.id)).toEqual(['extra', 'high']);
  });

  it('breaks score ties by id ascending', () => {
    const p = new Set(['a', 'b']);
    const items = [cand('zzz', ['a', 'b']), cand('aaa', ['a', 'b'])];
    const g = gate({ threshold: 0, minShared: 2, maxItems: 5 });
    const out = gatePromptRecall(p, items, g);
    expect(out.map((r) => r.item.id)).toEqual(['aaa', 'zzz']);
  });
});

describe('promptRecallFtsQuery', () => {
  it('joins the first maxTerms tokens in insertion order', () => {
    const p = new Set(['alpha', 'beta', 'gamma', 'delta']);
    expect(promptRecallFtsQuery(p, 2)).toBe('alpha beta');
  });

  it('defaults the cap to 32 terms', () => {
    const p = new Set(Array.from({ length: 40 }, (_, i) => `tok${i}`));
    expect(promptRecallFtsQuery(p).split(' ')).toHaveLength(32);
  });
});

describe('rarestPromptTerms', () => {
  it('picks the lowest-doc-count terms first, ties by term asc', () => {
    const counts = new Map([['common', 500], ['mid', 40], ['rare', 3], ['rarest', 1], ['tie', 3]]);
    const out = rarestPromptTerms(['common', 'mid', 'rare', 'rarest', 'tie'], (t) => counts.get(t) ?? 0, 3);
    expect(out).toEqual(['rarest', 'rare', 'tie']);
  });

  it('drops zero-count (out-of-vocab) terms entirely', () => {
    const counts = new Map([['known', 5]]);
    const out = rarestPromptTerms(['known', 'unknown'], (t) => counts.get(t) ?? 0, RAREST_TERM_COUNT);
    expect(out).toEqual(['known']);
  });

  it('defaults maxTerms to RAREST_TERM_COUNT (8)', () => {
    const terms = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const out = rarestPromptTerms(terms, () => 1, RAREST_TERM_COUNT);
    expect(out).toHaveLength(RAREST_TERM_COUNT);
  });
});
