import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  crossEncoderReranker,
  isCrossEncoderAvailable,
} from '../../src/rerankers/cross-encoder.js';
import { createMemory } from '../../src/memory.js';
import type { SearchResult } from '../../src/search.js';

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

describe('crossEncoderReranker', () => {
  let available = false;

  beforeAll(async () => {
    // Pragmatic probe: isCrossEncoderAvailable() only confirms the package
    // imports. In sandboxed environments the model download (Hugging Face
    // CDN) may be blocked, in which case the reranker silently falls back to
    // identity ordering. Probe with a one-pass call: if rerankScore equals
    // the input score, we're in fallback mode and the model-dependent tests
    // should skip.
    if (await isCrossEncoderAvailable()) {
      try {
        const out = await crossEncoderReranker('probe', [asResult('probe', 1.0)]);
        available = out[0].rerankScore !== 1.0;
      } catch {
        available = false;
      }
    }
  }, 60_000);

  it.runIf(() => available)(
    'reorders semantically related candidates above lexically related ones',
    async () => {
      const out = await crossEncoderReranker('how do I deploy to production', [
        asResult(
          'Production deployment runbook: run scripts/deploy.sh after CI passes',
          0.5,
        ),
        asResult('The word production appears in many places', 1.0),
      ]);
      expect(out[0].entry.content).toContain('runbook');
    },
  );

  it.runIf(() => available)('returns rerankScore on every result', async () => {
    const out = await crossEncoderReranker('test', [asResult('test content', 1.0)]);
    expect(out[0].rerankScore).toBeDefined();
    expect(typeof out[0].rerankScore).toBe('number');
  });

  it('falls back to identity ordering when cross-encoder is unavailable', async () => {
    // Always runs. Common-path assertions hold regardless of model availability;
    // identity-ordering assertions are gated on `!available` because a
    // loaded cross-encoder may legitimately reorder.
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    const out = await crossEncoderReranker('alpha', inputs);
    expect(out.length).toBe(2);
    expect(out.every((r) => r.rerankScore !== undefined)).toBe(true);
    if (!available) {
      // Lock the fallback contract: when the model isn't loadable, the
      // reranker MUST preserve input ordering exactly.
      expect(out[0].entry.content).toBe('alpha');
      expect(out[1].entry.content).toBe('beta');
    }
  });

  it('does not spam console.warn on repeated fallback calls', async () => {
    // The warn fires at most once per process on first identity-fallback.
    // beforeAll's probe call may have already consumed the warn on
    // fallback-mode machines, so the upper bound holds in both modes.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    await crossEncoderReranker('q', inputs);
    await crossEncoderReranker('q', inputs);
    await crossEncoderReranker('q', inputs);
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);
    warnSpy.mockRestore();
  });
});
