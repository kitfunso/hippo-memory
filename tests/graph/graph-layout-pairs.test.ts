// The layout looks at the pairs near each node, not every pair, and still lays out finite, bounded, repeatable points.
import { describe, expect, it } from 'vitest';
import { layoutGraph, type GraphModel } from '../../src/graph/view.js';

const NODES = 600;
const PASSES = 20;
const ALL_PAIRS_PER_PASS = (NODES * (NODES - 1)) / 2;

function ring(n: number): GraphModel {
  return {
    nodes: Array.from({ length: n }, (_, i) => ({ id: i + 1, type: 'system' as const, name: `n${i}` })),
    edges: Array.from({ length: n }, (_, i) => ({
      from: i + 1,
      to: ((i + 1) % n) + 1,
      relType: 'depends-on' as const,
    })),
    truncated: false,
  };
}

describe('layoutGraph at 600 nodes', () => {
  it('visits a small share of the pairs the all-pairs pass visited', () => {
    const visits = { pairs: 0 };
    layoutGraph(ring(NODES), { iterations: PASSES, visits });

    expect(visits.pairs).toBeGreaterThan(0);
    // All pairs would be 179,700 per pass; the grid keeps to the nodes in the 3 by 3 cells around each node.
    expect(visits.pairs).toBeLessThan((ALL_PAIRS_PER_PASS * PASSES) / 4);
  });

  it('keeps every point finite, inside the bounds and the same from run to run', () => {
    const a = layoutGraph(ring(NODES), { iterations: PASSES });
    const b = layoutGraph(ring(NODES), { iterations: PASSES });

    expect([...a.entries()]).toEqual([...b.entries()]);
    for (const p of a.values()) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(20);
      expect(p.x).toBeLessThanOrEqual(980);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(680);
    }
  });
});
