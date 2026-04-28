import { describe, it, expect } from 'vitest';
import { createMemory, Layer, type MemoryEntry } from '../src/memory.js';
import { computeAmbientState, renderAmbientSummary, formatAmbientVector } from '../src/ambient.js';

function mem(content: string, opts: {
  tags?: string[];
  layer?: Layer;
  emotional_valence?: string;
  created?: string;
  schema_fit?: number;
  extracted_from?: string;
  dag_level?: number;
} = {}): MemoryEntry {
  const entry = createMemory(content, {
    layer: opts.layer ?? Layer.Episodic,
    tags: opts.tags ?? [],
  });
  if (opts.emotional_valence) (entry as any).emotional_valence = opts.emotional_valence;
  if (opts.created) (entry as any).created = opts.created;
  if (opts.schema_fit !== undefined) (entry as any).schema_fit = opts.schema_fit;
  if (opts.extracted_from) (entry as any).extracted_from = opts.extracted_from;
  if (opts.dag_level !== undefined) (entry as any).dag_level = opts.dag_level;
  return entry;
}

describe('computeAmbientState', () => {
  it('returns zeroed state for empty entries', () => {
    const state = computeAmbientState([]);
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
    const state = computeAmbientState(entries);
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
    const uniformState = computeAmbientState(uniform);
    const concentratedState = computeAmbientState(concentrated);
    expect(uniformState.tagEntropy).toBeGreaterThan(concentratedState.tagEntropy);
  });

  it('computes recencyFreshness for recent entries', () => {
    const now = new Date();
    const recent = [
      mem('Fresh 1', { created: new Date(now.getTime() - 86400000).toISOString() }),
      mem('Fresh 2', { created: new Date(now.getTime() - 2 * 86400000).toISOString() }),
    ];
    const state = computeAmbientState(recent, now);
    expect(state.recencyFreshness).toBeGreaterThan(0.5);
  });

  it('computes emotionalSkew for negative-heavy corpus', () => {
    const entries = [
      mem('Error 1', { emotional_valence: 'negative' }),
      mem('Error 2', { emotional_valence: 'critical' }),
      mem('OK thing', { emotional_valence: 'neutral' }),
    ];
    const state = computeAmbientState(entries);
    expect(state.emotionalSkew).toBeGreaterThan(0);
  });

  it('computes consolidationRatio', () => {
    const entries = [
      mem('Semantic fact', { layer: Layer.Semantic }),
      mem('Semantic fact 2', { layer: Layer.Semantic }),
      mem('Episodic event', { layer: Layer.Episodic }),
    ];
    const state = computeAmbientState(entries);
    expect(state.consolidationRatio).toBeCloseTo(2 / 3, 1);
  });

  it('computes dagDepth from max dag_level', () => {
    const entries = [
      mem('Root', { dag_level: 0 }),
      mem('Mid', { dag_level: 1 }),
      mem('Deep', { dag_level: 3 }),
    ];
    const state = computeAmbientState(entries);
    expect(state.dagDepth).toBe(3);
  });

  it('computes extractionCoverage', () => {
    const entries = [
      mem('Episodic source', { layer: Layer.Episodic }),
      mem('Extracted fact', { layer: Layer.Episodic, extracted_from: 'some-id' }),
    ];
    const state = computeAmbientState(entries);
    expect(state.extractionCoverage).toBe(0.5);
  });

  it('skips superseded entries', () => {
    const entries = [
      mem('Active', { tags: ['a'] }),
      (() => { const e = mem('Old', { tags: ['b'] }); (e as any).superseded_by = 'xxx'; return e; })(),
    ];
    const state = computeAmbientState(entries);
    expect(state.totalMemories).toBe(2);
  });
});

describe('renderAmbientSummary', () => {
  it('returns empty message for zero memories', () => {
    const state = computeAmbientState([]);
    expect(renderAmbientSummary(state)).toContain('empty store');
  });

  it('produces a readable summary for a mixed corpus', () => {
    const entries = [
      mem('Fact A', { tags: ['topic:arch'], layer: Layer.Semantic }),
      mem('Fact B', { tags: ['error'], layer: Layer.Episodic, emotional_valence: 'negative' }),
      mem('Fact C', { tags: ['topic:deploy'], layer: Layer.Episodic }),
    ];
    const summary = renderAmbientSummary(computeAmbientState(entries));
    expect(summary).toContain('Memory state:');
    expect(summary).toContain('3 memories');
  });
});

describe('formatAmbientVector', () => {
  it('renders all 11 dimensions', () => {
    const entries = [mem('Test', { tags: ['a'] })];
    const output = formatAmbientVector(computeAmbientState(entries));
    expect(output).toContain('tag_entropy');
    expect(output).toContain('avg_strength');
    expect(output).toContain('total_memories');
    expect(output).toContain('dag_depth');
  });
});
