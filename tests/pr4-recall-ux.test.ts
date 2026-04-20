/**
 * PR4: Recall UX Polish tests.
 *
 * Tests the --why explainability layer and source annotations.
 * Validates at the search/explain level since CLI testing is brittle.
 */

import { describe, it, expect } from 'vitest';
import { search, hybridSearch, explainMatch, tokenize, SearchResult } from '../src/search.js';
import { createMemory, resolveConfidence, Layer } from '../src/memory.js';

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

    expect(results.length).toBeGreaterThan(0);

    const explanation = explainMatch('FRED cache failure', results[0]);
    expect(explanation.hasBm25).toBe(true);
    expect(explanation.hasEmbedding).toBe(false);
    expect(explanation.matchedTerms.length).toBeGreaterThan(0);
    expect(explanation.reason).toContain('BM25');
    expect(explanation.reason).toContain('matched terms');
  });

  it('includes specific matched terms in the explanation', () => {
    const entries = makeEntries();
    const results = search('cache refresh', entries, { budget: 10000 });

    expect(results.length).toBeGreaterThan(0);

    const explanation = explainMatch('cache refresh', results[0]);
    // At least one of 'cache' or 'refresh' should appear
    const hasRelevantTerm = explanation.matchedTerms.some(
      (t) => t === 'cache' || t === 'refresh'
    );
    expect(hasRelevantTerm).toBe(true);
  });

  it('returns cosine=0 for BM25-only results', () => {
    const entries = makeEntries();
    const results = search('FRED cache', entries, { budget: 10000 });
    expect(results.length).toBeGreaterThan(0);

    const explanation = explainMatch('FRED cache', results[0]);
    expect(explanation.cosineSimilarity).toBe(0);
    expect(explanation.hasEmbedding).toBe(false);
  });

  it('returns reason text that is non-empty', () => {
    const entries = makeEntries();
    const results = search('error pipeline', entries, { budget: 10000 });
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      const explanation = explainMatch('error pipeline', r);
      expect(explanation.reason.length).toBeGreaterThan(0);
    }
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
    expect(results.length).toBeGreaterThan(0);

    const r = results[0];
    // Verify all fields exist on SearchResult that --why needs
    expect(typeof r.score).toBe('number');
    expect(typeof r.bm25).toBe('number');
    expect(typeof r.cosine).toBe('number');
    expect(typeof r.entry.layer).toBe('string');
    expect(typeof r.entry.confidence).toBe('string');
    expect(typeof r.entry.id).toBe('string');
    expect(typeof r.entry.strength).toBe('number');

    // explainMatch produces the reason field
    const explanation = explainMatch('FRED cache', r);
    expect(typeof explanation.reason).toBe('string');
    expect(explanation.reason.length).toBeGreaterThan(0);
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
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.bm25).toBe('number');
      expect(typeof r.cosine).toBe('number');

      const explanation = explainMatch('FRED cache failure', r);
      expect(explanation.reason.length).toBeGreaterThan(0);
    }
  });
});
