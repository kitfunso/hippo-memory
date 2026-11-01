import { describe, it, expect } from 'vitest';
import {
  contentTokens,
  promptTokens,
  scoreOverlap,
  gatePromptRecall,
  rarestPromptTerms,
  ftsTermParts,
  rarestFtsQuery,
  RAREST_TERM_COUNT,
  type PromptRecallGate,
} from '../../src/base/rank/prompt-recall.js';

// promptTokens reads only this many prompt chars; pinned here so a change to the cut shows up as a test edit.
const PROMPT_RECALL_MAX_CHARS = 4000;

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

  it('keeps CJK bigrams, which are shorter than the length floor', () => {
    expect([...contentTokens('the 数据库 api')]).toEqual(['数据', '据库', 'api']);
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

describe('rarestPromptTerms', () => {
  it('picks the lowest-doc-count terms first, ties by term asc', () => {
    const counts = new Map([
      ['common', 500],
      ['mid', 40],
      ['rare', 3],
      ['rarest', 1],
      ['tie', 3],
    ]);
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

describe('ftsTermParts', () => {
  it('splits on what unicode61 treats as a separator, keeping letters and digits of any script', () => {
    expect(ftsTermParts('journal_mode')).toEqual(['journal', 'mode']);
    expect(ftsTermParts('café2go')).toEqual(['café2go']);
    expect(ftsTermParts('--')).toEqual([]);
  });
});

describe('rarestFtsQuery', () => {
  it('counts a split term as its rarest part and asks docCount about parts only', () => {
    const counts = new Map([
      ['journal', 9],
      ['mode', 2],
      ['wal', 5],
    ]);
    const asked: string[] = [];
    const out = rarestFtsQuery(['wal', 'journal_mode'], (part) => {
      asked.push(part);
      return counts.get(part) ?? 0;
    });
    expect(out).toBe('journal_mode wal');
    expect(asked.sort()).toEqual(['journal', 'mode', 'wal']);
  });

  it('drops a term with an unindexed part or no part at all', () => {
    const counts = new Map([
      ['journal', 9],
      ['wal', 5],
    ]);
    expect(rarestFtsQuery(['journal_nothing', '__', 'wal'], (part) => counts.get(part) ?? 0)).toBe('wal');
  });

  it('breaks ties by term and caps at RAREST_TERM_COUNT unless told otherwise', () => {
    const terms = Array.from({ length: 20 }, (_, i) => `t${String(i).padStart(2, '0')}`).reverse();
    expect(rarestFtsQuery(terms, () => 1).split(' ')).toEqual(terms.slice().sort().slice(0, RAREST_TERM_COUNT));
    expect(rarestFtsQuery(terms, () => 1, 2)).toBe('t00 t01');
  });

  it('without a CJK count, never asks the word index about a CJK term and gives CJK terms the slots words leave', () => {
    const counts = new Map([['postgres', 3]]);
    const asked: string[] = [];
    const docCount = (part: string): number => {
      asked.push(part);
      return counts.get(part) ?? 0;
    };
    expect(rarestFtsQuery(['数据', 'postgres', '据库', 'never'], docCount, 2)).toBe('postgres 数据');
    expect(asked.sort()).toEqual(['never', 'postgres']);
  });

  it('without a CJK count, keeps half the slots for CJK terms at even steps, however many words count', () => {
    const words = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const cjk = ['甲乙丙', '乙丙丁', '丙丁戊', '丁戊己', '戊己庚', '己庚辛', '庚辛壬'];
    expect(rarestFtsQuery([...words, ...cjk], () => 1, 8)).toBe('w0 w1 w2 w3 甲乙丙 丙丁戊 戊己庚 庚辛壬');
  });

  it('with a CJK count, ranks CJK and word terms in one rarest-first pick and drops a zero-count CJK term', () => {
    const wordCounts = new Map([
      ['postgres', 5],
      ['deploy', 2],
    ]);
    const cjkCounts = new Map([
      ['数据库', 1],
      ['据库连', 0],
      ['连接池', 3],
    ]);
    const asked: string[] = [];
    const cjkAsked: string[] = [];
    const counter = (log: string[], counts: Map<string, number>) => (term: string) => {
      log.push(term);
      return counts.get(term) ?? 0;
    };
    const out = rarestFtsQuery(
      ['postgres', 'deploy', '数据库', '据库连', '连接池'],
      counter(asked, wordCounts),
      3,
      counter(cjkAsked, cjkCounts),
    );
    expect(out).toBe('数据库 deploy 连接池');
    expect(asked.sort()).toEqual(['deploy', 'postgres']);
    expect(cjkAsked.sort()).toEqual(['据库连', '数据库', '连接池'].sort());
  });

  it('is the empty query when no term is indexed', () => {
    expect(rarestFtsQuery(['nothing', 'indexed'], () => 0)).toBe('');
    expect(rarestFtsQuery([], () => 1)).toBe('');
  });
});
