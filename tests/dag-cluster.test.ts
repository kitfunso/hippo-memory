import { describe, it, expect } from 'vitest';
import { clusterFacts } from '../src/dag.js';
import { createMemory, Layer } from '../src/memory.js';

describe('clusterFacts', () => {
  it('groups facts by entity/topic overlap', () => {
    const facts = [
      createMemory('John plays basketball daily', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
      }),
      createMemory('John wants to improve shooting percentage', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:John', 'topic:basketball'],
      }),
      createMemory('Tim enjoys reading sci-fi novels', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim', 'topic:reading'],
      }),
      createMemory('Tim recently read Dune by Frank Herbert', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Tim', 'topic:reading'],
      }),
    ];

    const clusters = clusterFacts(facts);

    expect(clusters.length).toBeGreaterThanOrEqual(2);

    const johnCluster = clusters.find((c) =>
      c.members.some((m) => m.content.includes('John')),
    );
    expect(johnCluster).toBeDefined();
    expect(johnCluster!.members.length).toBeGreaterThanOrEqual(2);
    expect(johnCluster!.label).toContain('John');
  });

  it('returns singletons as their own cluster', () => {
    const facts = [
      createMemory('Alice likes chess', {
        layer: Layer.Semantic, tags: ['extracted', 'speaker:Alice'],
      }),
    ];

    const clusters = clusterFacts(facts);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].members).toHaveLength(1);
  });
});
