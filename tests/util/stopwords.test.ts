/** Each stopword set keeps the members it had as a literal in its own module before they moved here. */
import { describe, expect, it } from 'vitest';
import {
  CONFLICT_STOPWORDS,
  FORWARD_CLAIM_STOPWORDS,
  INVALIDATION_STOPWORDS,
  MEMORY_QUALITY_STOPWORDS,
} from '../../src/base/util/stopwords.js';
import { jaccardSets, textOverlap } from '../../src/base/util/tokenize.js';

const WORDS = (text: string): string[] => text.split(' ');
const EXPECTED: Array<[string, ReadonlySet<string>, string[]]> = [
  [
    'MEMORY_QUALITY_STOPWORDS',
    MEMORY_QUALITY_STOPWORDS,
    WORDS(
      'the a an is was are were be been being to of in for on with at by from it this that and or but not no so if do did does has had have will would could should may might can shall we i you they he she my our your its his her their up out just also then than some all any each very too',
    ),
  ],
  [
    'CONFLICT_STOPWORDS',
    CONFLICT_STOPWORDS,
    WORDS(
      'the a an is was are were be been being to of in for on with at by from it this that and or but so if as we i you they he she my our your its his her their up out just also then than some all any each very too do did does has had have will would could should may might can shall when where what which who how why there here about into over after before between through during against within without toward upon more most less least other such same new old one two',
    ),
  ],
  [
    'INVALIDATION_STOPWORDS',
    INVALIDATION_STOPWORDS,
    WORDS(
      'the an is it in on at to for of by and or but not with from that this was are be has had have been will would could should do does did all our old new use used using',
    ),
  ],
  [
    'FORWARD_CLAIM_STOPWORDS',
    FORWARD_CLAIM_STOPWORDS,
    WORDS(
      'the a an and or but for to in on at of by with my your our their its it this that these those will should can i we they he she is be was are were has have had do does did from as so than then take taken takes ship ships finish complete land eta estimate estimated next about around day days week weeks month months hour hours hr hrs min mins minute minutes sec secs second seconds',
    ),
  ],
];

describe('stopword sets', () => {
  it.each(EXPECTED)('%s holds exactly its old members', (_name, set, words) => {
    expect([...set].sort()).toEqual([...words].sort());
  });
});

describe('jaccardSets', () => {
  it('counts two empty sets as identical and one empty set as disjoint', () => {
    expect(jaccardSets(new Set(), new Set())).toBe(1);
    expect(jaccardSets(new Set(['a']), new Set())).toBe(0);
  });
  it('divides the shared members by the union, and textOverlap agrees', () => {
    expect(jaccardSets(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd']))).toBe(0.5);
    expect(textOverlap('alpha beta gamma', 'beta gamma delta')).toBe(0.5);
  });
});
