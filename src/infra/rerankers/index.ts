// The reranker registry over the real services: fetch for the hosted rerankers, Transformers.js for the cross-encoder.
import type { RerankerFn, RerankerLookup } from '../../base/ports/reranker.js';
import { createCrossEncoderReranker } from '../../domain/rerankers/cross-encoder.js';
import { transformersCrossEncoder } from '../cross-encoder.js';
import { processHttp } from '../http.js';
import { createClefReranker } from './clef.js';
import { createJevReranker } from './jev.js';
import { createLlmReranker } from './llm.js';

/**
 * A new registry with its own cross-encoder: a root builds one and keeps it, so each model loads once and each outage
 * warning lasts the registry's life.
 */
export function realRerankers(): RerankerLookup {
  // jev falls back to the same cross-encoder, so one model loads.
  const crossEncoder = createCrossEncoderReranker(transformersCrossEncoder());
  const registry = {
    clef: createClefReranker('clef', processHttp),
    'clef-flash': createClefReranker('clef-flash', processHttp),
    'cross-encoder': crossEncoder,
    jev: createJevReranker(crossEncoder, processHttp),
    llm: createLlmReranker(processHttp),
  } satisfies Record<string, RerankerFn>;
  const isRegistered = (name: string): name is keyof typeof registry => Object.hasOwn(registry, name);
  return (name) => {
    if (!name) return null;
    if (!isRegistered(name)) {
      throw new Error(`Unknown reranker: ${name}. Available: ${Object.keys(registry).join(', ')}`);
    }
    return registry[name];
  };
}
