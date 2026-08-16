import { crossEncoderReranker } from './cross-encoder.js';
import { llmReranker } from './llm.js';
import type { RerankerFn } from './types.js';

const REGISTRY = {
  'cross-encoder': crossEncoderReranker,
  llm: llmReranker,
} satisfies Record<string, RerankerFn>;

type RegisteredRerankerName = keyof typeof REGISTRY;

function isRegisteredRerankerName(name: string): name is RegisteredRerankerName {
  return Object.hasOwn(REGISTRY, name);
}

export function getReranker(name: string | null | undefined): RerankerFn | null {
  if (!name) return null;
  if (!isRegisteredRerankerName(name)) {
    throw new Error(
      `Unknown reranker: ${name}. Available: ${Object.keys(REGISTRY).join(', ')}`,
    );
  }
  return REGISTRY[name];
}

export type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
