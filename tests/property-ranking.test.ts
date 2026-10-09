// The order recall gives scored candidates must come from the candidates alone: never from the order they arrived in, and a higher score never moves one down.
import { describe, it, expect } from 'vitest';
import { compareScoredResults, type ScoredEntryLike } from '../src/compare.js';
import { arr, both, forAll, int, map, pick, type Gen } from './_helpers/property.js';

// Few distinct values, so most draws tie on score and many tie on every key before the id.
const SCORES = [0, 0.5, 0.5, 1, 1, -1, 1e-9, 0.3, 0.1 + 0.2];
const CONTENTS = ['a', 'a', 'b', 'A', ''];
const LAYERS = [null, null, 'semantic', 'episodic', 'buffer', 'unlisted', ''];
const TAGS: readonly (readonly string[] | null)[] = [null, [], ['x'], ['x', 'y'], ['y', 'x'], ['x', 'x', 'y']];
const SOURCES = [null, null, 'cli', 'slack'];

type Draft = Omit<ScoredEntryLike['entry'], 'id'>;

/** A candidate that carries only the keys it drew: a missing layer, tag list or source is a tie key of its own. */
const DRAFT: Gen<Draft> = map(both(both(pick(CONTENTS), pick(LAYERS)), both(pick(TAGS), pick(SOURCES))), ([[content, layer], [tags, source]]) => {
  const draft: Draft = { content };
  if (layer !== null) draft.layer = layer;
  if (tags !== null) draft.tags = tags;
  if (source !== null) draft.source = source;
  return draft;
});

/** Candidates with ids unique within the list, as rows of one store are, each paired with a number that places it in a second arrival order. */
const ARRIVALS: Gen<{ scored: ScoredEntryLike; turn: number }[]> = map(
  arr(both(both(pick(SCORES), DRAFT), int(0, 99)), 0, 12),
  (drawn) => drawn.map(([[score, draft], turn], index) => ({ scored: { score, entry: { ...draft, id: `m${index}` } }, turn })),
);

function ranked(candidates: readonly ScoredEntryLike[]): string[] {
  return [...candidates].sort(compareScoredResults).map((c) => c.entry.id);
}

describe('ranking properties', () => {
  it('any arrival order of the same candidates ranks them the same, ties included', () => {
    forAll(0x7a9c, 500, ARRIVALS, (arrivals) => {
      const first = arrivals.map((a) => a.scored);
      const second = [...arrivals].sort((a, b) => a.turn - b.turn).map((a) => a.scored);
      const order = ranked(first);
      expect(ranked(second)).toEqual(order);
      expect(ranked([...first].reverse())).toEqual(order);
    });
  });

  it('raising one candidate\'s score never moves it down the ranking', () => {
    const raise = both(ARRIVALS, both(int(0, 11), pick([1e-9, 0.2, 0.5, 2])));
    forAll(0x4a15e, 500, raise, ([arrivals, [slot, by]]) => {
      const before = arrivals.map((a) => a.scored);
      if (before.length === 0) return;
      const chosen = before[slot % before.length]!;
      const after = before.map((c) => (c === chosen ? { ...c, score: c.score + by } : c));
      expect(ranked(after).indexOf(chosen.entry.id)).toBeLessThanOrEqual(ranked(before).indexOf(chosen.entry.id));
    });
  });
});
