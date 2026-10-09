import { createClefReranker } from './clef.js';
import { crossEncoderReranker } from './cross-encoder.js';
import { createJevReranker } from './jev.js';
import { createLlmReranker } from './llm.js';
import type { RerankerFn } from './types.js';

// Each hosted reranker is built once here, so its outage warning lasts the process.
const REGISTRY = {
  clef: createClefReranker('clef'),
  'clef-flash': createClefReranker('clef-flash'),
  'cross-encoder': crossEncoderReranker,
  jev: createJevReranker(crossEncoderReranker),
  llm: createLlmReranker(),
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
