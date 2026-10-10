/**
 * Tests for schema_fit computation — how well new memories fit existing patterns.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { computeSchemaFit, deriveHalfLife, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { loadNewestEntries, schemaFitInStore } from '../src/store/candidates.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { writeEntriesTogether, writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { makeRoot } from './_helpers/make-root.js';

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

describe('schemaFitInStore', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scores a tenant from the store as computeSchemaFit scores the same rows loaded', () => {
    const root = makeRoot('schema-fit-store');
    roots.push(root);
    const pool = [
      ...makePool(),
      createMemory('One row carrying a tag twice', { tags: ['rule', 'rule'] }),
      createMemory('A row with no tags at all'),
      // Eight matching texts pass the five that cap the content score, so the store's text walk stops early.
      ...Array.from({ length: 8 }, (_, i) => createMemory(`zephyrine refresh dropped series ${i}`, { tags: ['data-pipeline'] })),
    ];
    const elsewhere = createMemory('zephyrine refresh for another tenant', { tags: ['data-pipeline', 'error', 'kubernetes'], tenantId: 'other' });
    for (const entry of [...pool, elsewhere]) writeEntry(root, entry);
    const loaded = loadAllEntries(root, 'default');
    expect(loaded).toHaveLength(pool.length);

    // Each probe scores below the caps, so a wrong row count, tag count or text set moves it.
    const probes: ReadonlyArray<readonly [string, string[]]> = [
      ['', ['data-pipeline']],
      ['Never overwrite production files', ['rule', 'rule', 'unseen']],
      ['Kubernetes pod scaling requires HPA configuration', ['kubernetes']],
      ['Walk-forward Sharpe overestimates returns', []],
      ['another tenant', []],
    ];
    const fits = probes.map(([content, tags]) => schemaFitInStore(root, 'default', content, tags));
    expect(fits).toEqual(probes.map(([content, tags]) => computeSchemaFit(content, tags, loaded)));
    expect(fits.filter((fit) => fit > 0 && fit < 1)).toHaveLength(3);
    // No tags and a capped content score: 0.6 * 0 + 0.4 * 1.
    expect(schemaFitInStore(root, 'default', 'zephyrine refresh', [])).toBe(0.4);
    expect(schemaFitInStore(root, 'nobody', 'zephyrine refresh', ['data-pipeline'])).toBe(0.5);
  });

  it('scores against only the newest window of rows, not the whole tenant', () => {
    const root = makeRoot('schema-fit-window');
    roots.push(root);
    // Mirrors SCHEMA_FIT_WINDOW_ROWS in src/store/candidates.ts; a drift fails the fit comparison below.
    const windowRows = 2000;
    const oldest = Array.from({ length: 50 }, (_, i) => ({
      ...createMemory(`ancient ledger entry ${i}`, { tags: ['oldonly'] }),
      created: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
    }));
    const newest = Array.from({ length: windowRows }, (_, i) => ({
      ...createMemory(`recent pipeline note ${i}`, { tags: ['recent', i % 2 ? 'even' : 'odd'] }),
      created: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString(),
    }));
    writeEntriesTogether(root, [...oldest, ...newest]);
    const window = loadNewestEntries(root, 'default', windowRows);
    expect(window).toHaveLength(windowRows);
    expect(window.some((entry) => entry.tags.includes('oldonly'))).toBe(false);

    const tags = ['oldonly', 'recent'];
    const fit = schemaFitInStore(root, 'default', 'ancient ledger entry', tags);
    expect(fit).toBe(computeSchemaFit('ancient ledger entry', tags, window));
    expect(fit).not.toBe(computeSchemaFit('ancient ledger entry', tags, loadAllEntries(root, 'default')));
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

    expect(highFit.half_life_days).toBe(DEFAULT_HALF_LIFE_DAYS * 1.5);
    expect(lowFit.half_life_days).toBe(DEFAULT_HALF_LIFE_DAYS * 0.5);
    expect(neutral.half_life_days).toBe(DEFAULT_HALF_LIFE_DAYS);
  });
});
