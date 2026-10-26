import { describe, it, expect } from 'vitest';
import { createMemory } from '../../src/entry/memory.js';
import { Layer, type MemoryEntry, type EmotionalValence } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { computeAmbientState, renderAmbientSummary, formatAmbientVector } from '../../src/base/memory/ambient.js';
import { PRODUCTION_STRENGTH } from '../../src/base/memory/strength.js';
import { evalNow } from '../../src/infra/eval-switches.js';

function mem(
  content: string,
  opts: {
    tags?: string[];
    layer?: Layer;
    emotionalValence?: EmotionalValence;
    created?: string;
    schemaFit?: number;
    extractedFrom?: string;
    dagLevel?: number;
  } = {},
): MemoryEntry {
  const entry = createMemory(content, {
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
    layer: opts.layer ?? Layer.Episodic,
    tags: opts.tags ?? [],
  });
  if (opts.emotionalValence) entry.emotionalValence = opts.emotionalValence;
  if (opts.created) entry.created = opts.created;
  if (opts.schemaFit !== undefined) entry.schemaFit = opts.schemaFit;
  if (opts.extractedFrom) entry.extractedFrom = opts.extractedFrom;
  if (opts.dagLevel !== undefined) entry.dagLevel = opts.dagLevel;
  return entry;
}

describe('computeAmbientState', () => {
  it('returns zeroed state for empty entries', () => {
    const state = computeAmbientState([], evalNow(), PRODUCTION_STRENGTH);
    expect(state.totalMemories).toBe(0);
    expect(state.tagEntropy).toBe(0);
    expect(state.avgStrength).toBe(0);
  });

  it('computes totalMemories correctly', () => {
    const entries = [
      mem('Memory A', { tags: ['a'] }),
      mem('Memory B', { tags: ['b'] }),
      mem('Memory C', { tags: ['c'] }),
    ];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    expect(state.totalMemories).toBe(3);
  });

  it('computes tag entropy — diverse tags yield higher entropy', () => {
    const uniform = [
      mem('Alpha memory content', { tags: ['x'] }),
      mem('Beta memory content', { tags: ['y'] }),
      mem('Gamma memory content', { tags: ['z'] }),
    ];
    const concentrated = [
      mem('Alpha memory content', { tags: ['x'] }),
      mem('Beta memory content', { tags: ['x'] }),
      mem('Gamma memory content', { tags: ['x'] }),
    ];
    const uniformState = computeAmbientState(uniform, evalNow(), PRODUCTION_STRENGTH);
    const concentratedState = computeAmbientState(concentrated, evalNow(), PRODUCTION_STRENGTH);
    expect(uniformState.tagEntropy).toBeGreaterThan(concentratedState.tagEntropy);
  });

  it('computes recencyFreshness for recent entries', () => {
    const now = new Date();
    const recent = [
      mem('Fresh 1', { created: new Date(now.getTime() - 86400000).toISOString() }),
      mem('Fresh 2', { created: new Date(now.getTime() - 2 * 86400000).toISOString() }),
    ];
    const state = computeAmbientState(recent, now, PRODUCTION_STRENGTH);
    expect(state.recencyFreshness).toBeGreaterThan(0.5);
  });

  it('computes emotionalSkew for negative-heavy corpus', () => {
    const entries = [
      mem('Error 1', { emotionalValence: 'negative' }),
      mem('Error 2', { emotionalValence: 'critical' }),
      mem('OK thing', { emotionalValence: 'neutral' }),
    ];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    // Critical counts as negative, so two of three rows: (2 / 3) * 2 - 0.5.
    expect(state.emotionalSkew).toBeCloseTo(5 / 6, 10);
  });

  it('computes consolidationRatio', () => {
    const entries = [
      mem('Semantic fact', { layer: Layer.Semantic }),
      mem('Semantic fact 2', { layer: Layer.Semantic }),
      mem('Episodic event', { layer: Layer.Episodic }),
    ];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    expect(state.consolidationRatio).toBeCloseTo(2 / 3, 1);
  });

  it('computes dagDepth from max dag_level', () => {
    const entries = [mem('Root', { dagLevel: 0 }), mem('Mid', { dagLevel: 1 }), mem('Deep', { dagLevel: 3 })];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    expect(state.dagDepth).toBe(3);
  });

  it('computes extractionCoverage', () => {
    const entries = [
      mem('Episodic source', { layer: Layer.Episodic }),
      mem('Extracted fact', { layer: Layer.Episodic, extractedFrom: 'some-id' }),
    ];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    expect(state.extractionCoverage).toBe(0.5);
  });

  it('skips superseded entries', () => {
    const entries = [
      mem('Active', { tags: ['a'] }),
      (() => {
        const e = mem('Old', { tags: ['b'] });
        e.supersededBy = 'xxx';
        return e;
      })(),
    ];
    const state = computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH);
    expect(state.totalMemories).toBe(2);
  });
});

describe('renderAmbientSummary', () => {
  it('returns empty message for zero memories', () => {
    const state = computeAmbientState([], evalNow(), PRODUCTION_STRENGTH);
    expect(renderAmbientSummary(state)).toContain('empty store');
  });

  it('produces a readable summary for a mixed corpus', () => {
    const entries = [
      mem('Fact A', { tags: ['topic:arch'], layer: Layer.Semantic }),
      mem('Fact B', { tags: ['error'], layer: Layer.Episodic, emotionalValence: 'negative' }),
      mem('Fact C', { tags: ['topic:deploy'], layer: Layer.Episodic }),
    ];
    const summary = renderAmbientSummary(computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH));
    expect(summary).toContain('Memory state:');
    expect(summary).toContain('3 memories');
  });
});

describe('formatAmbientVector', () => {
  it('renders all 11 dimensions', () => {
    const entries = [mem('Test', { tags: ['a'] })];
    const output = formatAmbientVector(computeAmbientState(entries, evalNow(), PRODUCTION_STRENGTH));
    expect(output).toContain('tag_entropy');
    expect(output).toContain('avg_strength');
    expect(output).toContain('total_memories');
    expect(output).toContain('dag_depth');
  });
});
