/**
 * Tests for schema_fit computation — how well new memories fit existing patterns.
 */

import { describe, it, expect } from 'vitest';
import { createMemory, computeSchemaFit, deriveHalfLife, type MemoryEntry } from '../src/memory.js';

function makePool(): MemoryEntry[] {
  return [
    createMemory('FRED cache dropped tips_10y', { tags: ['data-pipeline', 'fred', 'error'] }),
    createMemory('EIA API path changed silently', { tags: ['data-pipeline', 'eia', 'error'] }),
    createMemory('Cache refresh reported OK but data was stale', { tags: ['data-pipeline', 'staleness', 'error'] }),
    createMemory('Walk-forward Sharpe overestimates by 50%', { tags: ['quant', 'backtest', 'sharpe'] }),
    createMemory('Equal weight beats optimization', { tags: ['quant', 'portfolio'] }),
    createMemory('Never overwrite production files', { tags: ['production', 'rule'] }),
  ];
}

describe('computeSchemaFit', () => {
  it('returns 0.5 (neutral) when no existing entries', () => {
    const fit = computeSchemaFit('some new memory', ['test'], []);
    expect(fit).toBe(0.5);
  });

  it('returns high fit for content+tags matching existing patterns', () => {
    const pool = makePool();
    // New memory about data pipeline errors — fits the dominant pattern
    const fit = computeSchemaFit(
      'World Bank data download failed with SSL error',
      ['data-pipeline', 'error'],
      pool
    );
    expect(fit).toBeGreaterThan(0.5);
  });

  it('returns low fit for completely novel content+tags', () => {
    const pool = makePool();
    // New memory about something entirely different
    const fit = computeSchemaFit(
      'Kubernetes pod scaling requires HPA configuration',
      ['kubernetes', 'devops', 'infrastructure'],
      pool
    );
    expect(fit).toBeLessThan(0.3);
  });

  it('tag overlap matters: shared rare tags score higher than no overlap', () => {
    const pool = makePool();

    const fitWithTags = computeSchemaFit(
      'New data source failed',
      ['data-pipeline', 'error'],
      pool
    );
    const fitNoTags = computeSchemaFit(
      'New data source failed',
      ['unrelated', 'novel'],
      pool
    );

    expect(fitWithTags).toBeGreaterThan(fitNoTags);
  });

  it('content overlap contributes to schema fit', () => {
    const pool = makePool();

    // Same tags but different content relevance
    const fitRelevantContent = computeSchemaFit(
      'FRED cache silently dropped another series during refresh',
      [],  // no tags
      pool
    );
    const fitIrrelevantContent = computeSchemaFit(
      'Kubernetes namespace isolation for multi-tenant clusters',
      [],  // no tags
      pool
    );

    expect(fitRelevantContent).toBeGreaterThan(fitIrrelevantContent);
  });

  it('fit is clamped to [0, 1]', () => {
    const pool = makePool();
    const fit = computeSchemaFit(
      'data-pipeline FRED cache error staleness EIA refresh',
      ['data-pipeline', 'fred', 'eia', 'error', 'staleness', 'cache'],
      pool
    );
    expect(fit).toBeGreaterThanOrEqual(0);
    expect(fit).toBeLessThanOrEqual(1);
  });
});

describe('schema_fit affects half-life', () => {
  it('high schema_fit (>0.7) gives 1.5x half-life', () => {
    const base = 7;
    const hl = deriveHalfLife(base, { tags: [], schema_fit: 0.85 });
    expect(hl).toBe(base * 1.5);
  });

  it('low schema_fit (<0.3) gives 0.5x half-life', () => {
    const base = 7;
    const hl = deriveHalfLife(base, { tags: [], schema_fit: 0.15 });
    expect(hl).toBe(base * 0.5);
  });

  it('neutral schema_fit (0.3-0.7) leaves half-life unchanged', () => {
    const base = 7;
    const hl = deriveHalfLife(base, { tags: [], schema_fit: 0.5 });
    expect(hl).toBe(base);
  });

  it('error tag + high schema_fit stack: 2x * 1.5x = 3x', () => {
    const base = 7;
    const hl = deriveHalfLife(base, { tags: ['error'], schema_fit: 0.85 });
    expect(hl).toBe(base * 2 * 1.5);
  });
});

describe('end-to-end: schema_fit flows through createMemory', () => {
  it('explicit schema_fit affects half-life in created memory', () => {
    const highFit = createMemory('test', { schema_fit: 0.85 });
    const lowFit = createMemory('test', { schema_fit: 0.15 });
    const neutral = createMemory('test', { schema_fit: 0.5 });

    expect(highFit.half_life_days).toBe(7 * 1.5);
    expect(lowFit.half_life_days).toBe(7 * 0.5);
    expect(neutral.half_life_days).toBe(7);
  });
});
