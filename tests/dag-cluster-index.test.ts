// clusterFacts compares a fact only with facts sharing an entity tag, and still returns what the all-pairs scan returned.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemory } from './_helpers/default-half-life-memory.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { clusterFacts } from '../src/consolidate/dag.js';

/** The all-pairs scan clusterFacts used to run, kept as the oracle for its output. */
function allPairsClusters(facts: MemoryEntry[]) {
  const entityTags = facts.map((f) => f.tags.filter((t) => t.startsWith('speaker:') || t.startsWith('topic:')));
  const assigned = new Set<number>();
  const clusters: { label: string; members: MemoryEntry[]; entityTags: string[] }[] = [];
  for (let i = 0; i < facts.length; i++) {
    if (assigned.has(i)) continue;
    const cluster = [i];
    assigned.add(i);
    for (let j = i + 1; j < facts.length; j++) {
      if (assigned.has(j)) continue;
      const shared = entityTags[i].filter((t) => entityTags[j].includes(t));
      const union = new Set([...entityTags[i], ...entityTags[j]]);
      if ((union.size > 0 ? shared.length / union.size : 0) >= 0.5) {
        cluster.push(j);
        assigned.add(j);
      }
    }
    const sharedTags = entityTags[cluster[0]].filter((t) => cluster.every((idx) => entityTags[idx].includes(t)));
    const members = cluster.map((idx) => facts[idx]);
    clusters.push({ label: sharedTags.map((t) => t.split(':')[1]).join(': ') || members[0].content.slice(0, 40), members, entityTags: sharedTags });
  }
  return clusters;
}

/** Deterministic pseudo-random facts over a small tag pool, with repeated tags and untagged facts mixed in. */
function randomFacts(seed: number, n: number): MemoryEntry[] {
  let state = seed;
  const next = (k: number): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % k;
  };
  const pool = ['speaker:alice', 'speaker:bob', 'speaker:cara', 'topic:deploy', 'topic:billing', 'topic:hiring', 'topic:cache', 'misc:x'];
  return Array.from({ length: n }, (_, i) => {
    const tags = Array.from({ length: next(4) }, () => pool[next(pool.length)]);
    return createMemory(`fact number ${i} for the cluster check`, { tags });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Set.has and Array.includes calls one clusterFacts run makes over `n` facts in disjoint pairs, each pair one cluster. */
function membershipChecks(n: number): number {
  const facts = Array.from({ length: n }, (_, i) =>
    createMemory(`fact ${i} about group ${Math.floor(i / 2)}`, { tags: [`topic:group${Math.floor(i / 2)}`] }));
  const has = vi.spyOn(Set.prototype, 'has');
  const includes = vi.spyOn(Array.prototype, 'includes');
  const clusters = clusterFacts(facts);
  const checks = has.mock.calls.length + includes.mock.calls.length;
  vi.restoreAllMocks();
  expect(clusters).toHaveLength(n / 2);
  return checks;
}

describe('clusterFacts', () => {
  it('returns the clusters the all-pairs scan returned, repeated tags and untagged facts included', () => {
    for (const seed of [1, 7, 42, 1234, 99991]) {
      const facts = randomFacts(seed, 120);
      expect(clusterFacts(facts)).toEqual(allPairsClusters(facts));
    }
  });

  it('compares each fact only with facts that share a tag, so membership checks grow with the facts, not their pairs', () => {
    // Equal steps mean the checks are linear in n; the all-pairs scan's steps grow with n.
    const [a, b, c] = [300, 600, 900].map(membershipChecks);
    expect(c - b).toBe(b - a);
  });
});
