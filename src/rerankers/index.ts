import { createClefReranker } from './clef.js';
import { createCrossEncoderReranker } from './cross-encoder.js';
import { createJevReranker } from './jev.js';
import { createLlmReranker } from './llm.js';
import type { RerankerFn } from './types.js';

// Each reranker is built once here, so its outage warning lasts the process; jev falls back to the same cross-encoder, so one model loads.
const crossEncoder = createCrossEncoderReranker();
const REGISTRY = {
  clef: createClefReranker('clef'),
  'clef-flash': createClefReranker('clef-flash'),
  'cross-encoder': crossEncoder,
  jev: createJevReranker(crossEncoder),
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
