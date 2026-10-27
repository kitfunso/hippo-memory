import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createCrossEncoderReranker } from '../../src/domain/rerankers/cross-encoder.js';
import { transformersCrossEncoder } from '../../src/infra/cross-encoder.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { SearchResult } from '../../src/base/rank/search-types.js';

const crossEncoderReranker = createCrossEncoderReranker(transformersCrossEncoder());

function asResult(content: string, score: number): SearchResult {
  return { entry: createMemory(content), score, bm25: score, cosine: 0, tokens: 10 };
}

function transformersInstalled(): boolean {
  try {
    createRequire(import.meta.url).resolve('@huggingface/transformers');
    return true;
  } catch {
    return false;
  }
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === 'number';
}

interface Probe {
  /** The model ran: a score moved off the input score. */
  readonly live: boolean;
  /** The model ran and told a match from nonsense. */
  readonly available: boolean;
}

// Probe for DISCRIMINATION, not liveness: a match and nonsense must score apart, since one score
// against the input score cannot tell a fallback from a constant-output model.
async function probeModel(): Promise<Probe> {
  if (!transformersInstalled()) return { live: false, available: false };
  try {
    const [hit, miss] = await Promise.all([
      crossEncoderReranker('how do I deploy', [asResult('production deployment runbook', 0.5)]),
      crossEncoderReranker('how do I deploy', [asResult('zebra hovercraft banana', 0.5)]),
    ]);
    // The fallback path echoes the input score (0.5 here), so a score
    // that moved off 0.5 proves the model actually ran.
    const finite = Number.isFinite(hit[0].rerankScore) && Number.isFinite(miss[0].rerankScore);
    const live = finite && (hit[0].rerankScore !== 0.5 || miss[0].rerankScore !== 0.5);
    return { live, available: live && hit[0].rerankScore !== miss[0].rerankScore };
  } catch {
    return { live: false, available: false };
  }
}

// One probe per file, awaited in each test body: the model load counts against the test budget, which the model job
// raises from the command line, and never against a hook's.
let probed: Promise<Probe> | undefined;
const probe = (): Promise<Probe> => (probed ??= probeModel());

describe('crossEncoderReranker', () => {
  // runIf takes a boolean evaluated at collection time, before any probe has
  // run, so the model probe has to gate inside the test body instead.
  it('reorders semantically related candidates above lexically related ones', async (ctx) => {
    if (!(await probe()).available) ctx.skip();
    // Decoy FIRST on purpose: identity ordering must fail this test, or a
    // silent fallback passes it for the wrong reason.
    const out = await crossEncoderReranker('how do I deploy to production', [
      asResult('The word production appears in many places', 1.0),
      asResult('Production deployment runbook: run scripts/deploy.sh after CI passes', 0.5),
    ]);
    expect(out[0].entry.content).toContain('runbook');
  });

  it('returns rerankScore on every result', async (ctx) => {
    if (!(await probe()).available) ctx.skip();
    const out = await crossEncoderReranker('test', [asResult('test content', 1.0)]);
    expect(isNumber(out[0].rerankScore)).toBe(true);
  });

  it('falls back to identity ordering when cross-encoder is unavailable', async () => {
    // Always runs. Common-path assertions hold regardless of model availability;
    // identity-ordering assertions are gated on `!available` because a
    // loaded cross-encoder may legitimately reorder.
    const { available } = await probe();
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
    const { live, available } = await probe();
    if (!live) ctx.skip();
    expect(available).toBe(true);
  });

  it('loads the real model when the environment promises one', async (ctx) => {
    if (!process.env.HIPPO_REQUIRE_CROSS_ENCODER) ctx.skip();
    expect((await probe()).live).toBe(true);
  });

  it('does not spam console.warn on repeated fallback calls', async () => {
    // Calls inside the five-minute repeat window share one warning, and the
    // probe may already have used it, so the upper bound holds in both modes.
    await probe();
    const warnSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const inputs = [asResult('alpha', 1.0), asResult('beta', 0.5)];
    await crossEncoderReranker('q', inputs);
    await crossEncoderReranker('q', inputs);
    await crossEncoderReranker('q', inputs);
    expect(warnSpy.mock.calls.length).toBeLessThanOrEqual(1);
    warnSpy.mockRestore();
  });
});
