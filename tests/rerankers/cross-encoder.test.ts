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

function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

describe('crossEncoderReranker', () => {
  let available = false;
  let live = false;

  beforeAll(async () => {
    // Probe for DISCRIMINATION, not liveness: score a matching and a nonsense
    // candidate and require them to differ. Comparing one score against the
    // input score cannot tell a fallback from a constant-output model.
    if (await isCrossEncoderAvailable()) {
      try {
        const [hit, miss] = await Promise.all([
          crossEncoderReranker('how do I deploy', [asResult('production deployment runbook', 0.5)]),
          crossEncoderReranker('how do I deploy', [asResult('zebra hovercraft banana', 0.5)]),
        ]);
        // The fallback path echoes the input score (0.5 here), so a score
        // that moved off 0.5 proves the model actually ran.
        const finite = Number.isFinite(hit[0].rerankScore) && Number.isFinite(miss[0].rerankScore);
        live = finite && (hit[0].rerankScore !== 0.5 || miss[0].rerankScore !== 0.5);
        available = live && hit[0].rerankScore !== miss[0].rerankScore;
      } catch {
        available = false;
      }
    }
  }, 180_000);

  // runIf takes a boolean evaluated at collection time, before beforeAll has
  // run, so the model probe has to gate inside the test body instead.
  it('reorders semantically related candidates above lexically related ones', async (ctx) => {
    if (!available) ctx.skip();
    // Decoy FIRST on purpose: identity ordering must fail this test, or a
    // silent fallback passes it for the wrong reason.
    const out = await crossEncoderReranker('how do I deploy to production', [
      asResult('The word production appears in many places', 1.0),
      asResult('Production deployment runbook: run scripts/deploy.sh after CI passes', 0.5),
    ]);
    expect(out[0].entry.content).toContain('runbook');
  });

  it('returns rerankScore on every result', async (ctx) => {
    if (!available) ctx.skip();
    const out = await crossEncoderReranker('test', [asResult('test content', 1.0)]);
    expect(out[0].rerankScore).toBeDefined();
    expect(isNumber(out[0].rerankScore)).toBe(true);
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

  it('a live model never scores every candidate the same', async (ctx) => {
    if (!live) ctx.skip();
    expect(available).toBe(true);
  });

  it('loads the real model when the environment promises one', async (ctx) => {
    if (!process.env.HIPPO_REQUIRE_CROSS_ENCODER) ctx.skip();
    expect(live).toBe(true);
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
