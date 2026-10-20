/**
 * PR4: Recall UX Polish tests.
 *
 * Tests the --why explainability layer and source annotations.
 * Validates at the search/explain level since CLI testing is brittle.
 */

import { describe, it, expect } from 'vitest';
import { search } from '../../src/domain/search/bm25-search.js';
import { hybridSearch } from '../../src/entry/folder-search.js';
import { explainMatch } from '../../src/domain/search/explain.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';
import { tokenize } from '../../src/base/util/tokenize.js';
import { resolveConfidence, Layer } from '../../src/base/memory/memory.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntries() {
  return [
    createMemory('FRED cache silently dropped the TIPS series during daily refresh', {
      tags: ['error', 'data-pipeline'],
    }),
    createMemory('Gold model uses TIPS 10y as primary inflation signal', {
      tags: ['model', 'gold'],
    }),
    createMemory('Always verify cache contents after refresh failures', {
      tags: ['error'],
    }),
    createMemory('Equities tend to rally in Q4 due to tax-loss harvesting reversal', {
      tags: ['equities'],
    }),
  ];
}

// ---------------------------------------------------------------------------
// tokenize (newly exported)
// ---------------------------------------------------------------------------

describe('tokenize export', () => {
  it('lowercases and splits on whitespace', () => {
    const tokens = tokenize('FRED Cache Error');
    expect(tokens).toEqual(['fred', 'cache', 'error']);
  });

  it('strips punctuation', () => {
    const tokens = tokenize('hello, world! foo-bar');
    expect(tokens).toEqual(['hello', 'world', 'foo', 'bar']);
  });

  it('filters single-character tokens', () => {
    const tokens = tokenize('a b cd ef');
    expect(tokens).toEqual(['cd', 'ef']);
  });
});

// ---------------------------------------------------------------------------
// explainMatch: BM25-only results
// ---------------------------------------------------------------------------

describe('explainMatch', () => {
  it('identifies matched BM25 terms for a keyword query', () => {
    const entries = makeEntries();
    const results = search('FRED cache failure', entries, { budget: 10000 });

    // No stemming, so 'failure' misses 'failures'; the FRED row also holds the rarer term and ranks first.
    expect(results.map((r) => r.entry.id)).toEqual([entries[0].id, entries[2].id]);

    const explanation = explainMatch('FRED cache failure', results[0]);
    expect(explanation.hasBm25).toBe(true);
    expect(explanation.hasEmbedding).toBe(false);
    expect(explanation.matchedTerms).toEqual(['fred', 'cache']);
    expect(explanation.reason).toBe('BM25: matched terms [fred, cache]');
  });

  it('includes specific matched terms in the explanation', () => {
    const entries = makeEntries();
    const results = search('cache refresh', entries, { budget: 10000 });

    // Both rows hold both terms; the shorter one ranks first.
    expect(results.map((r) => r.entry.id)).toEqual([entries[2].id, entries[0].id]);

    const explanation = explainMatch('cache refresh', results[0]);
    expect(explanation.matchedTerms).toEqual(['cache', 'refresh']);
  });

  it('returns cosine=0 for BM25-only results', () => {
    const entries = makeEntries();
    const results = search('FRED cache', entries, { budget: 10000 });
    expect(results.map((r) => r.entry.id)).toEqual([entries[0].id, entries[2].id]);

    const explanation = explainMatch('FRED cache', results[0]);
    expect(explanation.cosineSimilarity).toBe(0);
    expect(explanation.hasEmbedding).toBe(false);
  });

  it('returns reason text that is non-empty', () => {
    const entries = makeEntries();
    const results = search('error pipeline', entries, { budget: 10000 });

    // 'pipeline' comes only from the FRED row's data-pipeline tag; 'error' is a tag on two rows.
    expect(results.map((r) => explainMatch('error pipeline', r).reason)).toEqual([
      'BM25: matched terms [error, pipeline]',
      'BM25: matched terms [error]',
    ]);
  });

  it('handles a result with no BM25 and no embedding match gracefully', () => {
    // Construct a synthetic SearchResult with zero scores
    const entry = createMemory('something completely unrelated');
    const fakeResult: SearchResult = {
      entry,
      score: 0,
      bm25: 0,
      cosine: 0,
      tokens: 10,
    };

    const explanation = explainMatch('FRED cache', fakeResult);
    expect(explanation.hasBm25).toBe(false);
    expect(explanation.hasEmbedding).toBe(false);
    expect(explanation.reason).toContain('no direct term or embedding match');
  });

  it('detects embedding contribution when cosine > 0', () => {
    const entry = createMemory('deployment pipeline broke after merge');
    const syntheticResult: SearchResult = {
      entry,
      score: 0.7,
      bm25: 0.3,
      cosine: 0.85,
      tokens: 15,
    };

    const explanation = explainMatch('CI deployment failure', syntheticResult);
    expect(explanation.hasEmbedding).toBe(true);
    expect(explanation.hasBm25).toBe(true);
    expect(explanation.reason).toContain('embedding similarity');
    expect(explanation.reason).toContain('BM25');
    expect(explanation.cosineSimilarity).toBe(0.85);
  });
});

// ---------------------------------------------------------------------------
// --why JSON output shape
// ---------------------------------------------------------------------------

describe('--why JSON output fields', () => {
  it('search results contain all fields needed for --why annotation', () => {
    const entries = makeEntries();
    const results = search('FRED cache', entries, { budget: 10000 });
    expect(results).toHaveLength(2);

    const r = results[0];
    // Verify all fields exist on SearchResult that --why needs
    expect(r.score).toBeTypeOf('number');
    expect(r.bm25).toBeTypeOf('number');
    expect(r.cosine).toBeTypeOf('number');
    expect(r.entry.layer).toBeTypeOf('string');
    expect(r.entry.confidence).toBeTypeOf('string');
    expect(r.entry.id).toBeTypeOf('string');
    expect(r.entry.strength).toBeTypeOf('number');

    // explainMatch produces the reason field
    const explanation = explainMatch('FRED cache', r);
    expect(explanation.reason).toBeTypeOf('string');
    expect(explanation.reason).toBe('BM25: matched terms [fred, cache]');
  });

  it('resolveConfidence returns valid confidence level', () => {
    const entry = createMemory('test', { confidence: 'observed' });
    const conf = resolveConfidence(entry);
    expect(['verified', 'observed', 'inferred', 'stale']).toContain(conf);
  });
});

// ---------------------------------------------------------------------------
// Source bucket annotation
// ---------------------------------------------------------------------------

describe('source bucket annotation', () => {
  it('entry.layer maps to valid bucket names', () => {
    const bufferEntry = createMemory('buffer test', { layer: Layer.Buffer });
    const episodicEntry = createMemory('episodic test', { layer: Layer.Episodic });
    const semanticEntry = createMemory('semantic test', { layer: Layer.Semantic });

    expect(bufferEntry.layer).toBe('buffer');
    expect(episodicEntry.layer).toBe('episodic');
    expect(semanticEntry.layer).toBe('semantic');
  });

  it('confidence levels cover the expected set', () => {
    const verified = createMemory('verified confidence test', { confidence: 'verified' });
    const observed = createMemory('observed confidence test', { confidence: 'observed' });
    const inferred = createMemory('inferred confidence test', { confidence: 'inferred' });

    expect(resolveConfidence(verified)).toBe('verified');
    expect(resolveConfidence(observed)).toBe('observed');
    expect(resolveConfidence(inferred)).toBe('inferred');
  });
});

// ---------------------------------------------------------------------------
// hybridSearch --why compatibility
// ---------------------------------------------------------------------------

describe('hybridSearch results carry explainMatch data', () => {
  it('hybridSearch results include bm25 and cosine fields', async () => {
    const entries = makeEntries();
    const results = await hybridSearch('FRED cache failure', entries, { budget: 10000 });

    for (const r of results) {
      expect(r.bm25).toBeTypeOf('number');
      expect(r.cosine).toBeTypeOf('number');
    }
    // No hippoRoot means no stored vectors, so hybrid ranks by BM25 alone, as search does.
    expect(results.map((r) => explainMatch('FRED cache failure', r).reason)).toEqual([
      'BM25: matched terms [fred, cache]',
      'BM25: matched terms [cache]',
    ]);
  });
});
