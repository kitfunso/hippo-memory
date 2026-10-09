import { describe, expect, it } from 'vitest';
import { detectConflicts } from '../src/consolidate/conflicts.js';
import { mergePartners } from '../src/consolidate/merge.js';
import { Layer, type MemoryEntry } from '../src/core/memory.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { tokenize } from '../src/util/tokenize.js';
import { pairwiseDetectConflicts, pairwiseMergePartners } from './_helpers/pairwise-sleep-oracle.js';
import { mulberry32 } from './_helpers/property.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SIZES = [0, 1, 2, 3, 8, 30, 120, 300];
const SEEDS_PER_SIZE = 4;

// A small shared vocabulary so random texts collide often, plus the polarity words, stopwords and punctuation the rules key on.
const TOPIC = ['deploy', 'cache', 'Redis', 'auth', 'token', 'retry', 'queue', 'schema', 'index', 'build', 'lint', 'port', 'api', 'db', 'x', 'v2', 'café', 'rate_limit', 'flag', 'cron'];
const STOP = ['the', 'a', 'to', 'of', 'in', 'for', 'on', 'with', 'is', 'it', 'and', 'we', 'when', 'after', 'new', 'one'];
const POLAR = ['always', 'never', 'must', 'must not', 'enabled', 'disabled', 'enable', 'disable', 'not', "don't", 'true', 'true.', 'false,', 'yes', 'no', 'works', 'broken', 'off', 'available', 'missing'];

function randomTexts(rnd: () => number, n: number): string[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const texts: string[] = [];
  for (let k = 0; k < n; k++) {
    if (texts.length > 0 && rnd() < 0.4) {
      const words = pick(texts).split(' ');
      words[Math.floor(rnd() * words.length)] = pick(rnd() < 0.5 ? POLAR : TOPIC);
      if (rnd() < 0.5) words.unshift(pick(POLAR));
      texts.push(words.join(' '));
      continue;
    }
    const len = 2 + Math.floor(rnd() * (rnd() < 0.1 ? 70 : 14));
    const words: string[] = [];
    for (let w = 0; w < len; w++) {
      const r = rnd();
      words.push(pick(r < 0.25 ? STOP : r < 0.45 ? POLAR : TOPIC));
    }
    texts.push(words.join(rnd() < 0.2 ? ', ' : ' '));
  }
  return texts.map((t) => (t.trim().length < 3 ? `${t} ok` : t));
}

function randomEntries(rnd: () => number, n: number): MemoryEntry[] {
  return randomTexts(rnd, n).map((text, k) => {
    const r = rnd();
    const layer = r < 0.1 ? Layer.Semantic : r < 0.25 ? Layer.Trace : Layer.Episodic;
    const tags = rnd() < 0.05 ? ['extracted'] : rnd() < 0.05 ? ['session-digest'] : [];
    const created = new Date(NOW.getTime() - Math.floor(rnd() * 60) * DAY).toISOString();
    return {
      ...createMemory(text, { layer, tags }),
      id: `e${k}`,
      created,
      last_retrieved: created,
      half_life_days: [1, 7, 30][Math.floor(rnd() * 3)],
      superseded_by: rnd() < 0.05 ? 'e0' : null,
      scope: rnd() < 0.05 ? 'quarantine:private:test' : null,
    };
  });
}

const cases = SIZES.flatMap((n) => Array.from({ length: SEEDS_PER_SIZE }, (_, s) => ({ n, seed: n * 101 + s })));

describe('sleep overlap index matches the pairwise passes', () => {
  it.each(cases)('conflicts match for $n memories (seed $seed)', ({ n, seed }) => {
    const rnd = mulberry32(seed);
    const entries = randomEntries(rnd, n);
    const rescued = new Set(entries.filter(() => rnd() < 0.1).map((e) => e.id));
    expect(detectConflicts(entries, NOW, {}, rescued)).toEqual(pairwiseDetectConflicts(entries, NOW, {}, rescued));
  });

  it.each(cases)('merge partners match for $n memories (seed $seed)', ({ n, seed }) => {
    // Sleep only offers texts with at least one token to the merge pass.
    const texts = randomTexts(mulberry32(seed), n).filter((t) => tokenize(t).length > 0);
    const partnersOf = mergePartners(texts);
    expect(texts.map((_, i) => partnersOf(i))).toEqual(pairwiseMergePartners(texts));
  });

  it('keeps pairs that sit exactly on each threshold', () => {
    const shared = ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg'];
    // 7 shared of 20 distinct tokens is a Jaccard of exactly 0.35; dropping one shared token falls just under.
    const onMerge = [[...shared, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6'].join(' '), [...shared, 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7'].join(' ')];
    const underMerge = [onMerge[0], onMerge[1].replace('gg', 'q8')];
    for (const texts of [onMerge, underMerge]) {
      expect(texts.map((_, i) => mergePartners(texts)(i))).toEqual(pairwiseMergePartners(texts));
    }
    expect(mergePartners(onMerge)(0)).toEqual([1]);

    // 3 shared of 6 distinct tokens is a Jaccard of exactly 0.5.
    const onConflict = ['always alpha beta gamma', 'never alpha beta gamma zeta', 'never alpha beta gamma zeta eta'].map((text, k) => ({
      ...createMemory(text, {}), id: `c${k}`, created: NOW.toISOString(), last_retrieved: NOW.toISOString(),
    }));
    const got = detectConflicts(onConflict, NOW);
    expect(got).toEqual(pairwiseDetectConflicts(onConflict, NOW));
    expect(got.map((c) => [c.memory_a_id, c.memory_b_id])).toEqual([['c0', 'c1']]);
  });
});
