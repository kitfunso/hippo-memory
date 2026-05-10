import { featuresReranker } from './features.js';
import { crossEncoderReranker } from './cross-encoder.js';
import type { RerankerFn } from './types.js';

const REGISTRY: Record<string, RerankerFn> = {
  features: featuresReranker,
  'cross-encoder': crossEncoderReranker,
};

export function getReranker(name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  const fn = REGISTRY[name];
  if (!fn) {
    throw new Error(
      `Unknown reranker: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return fn;
}

export type { RerankerFn, RerankResult, RerankerOptions, RerankSignals } from './types.js';
