import type { CrossEncoderLoad } from '../../base/ports/cross-encoder.js';
import type { Http } from '../../base/ports/http.js';
import { createClefReranker } from './clef.js';
import { createCrossEncoderReranker } from './cross-encoder.js';
import { createJevReranker } from './jev.js';
import { createLlmReranker } from './llm.js';
import type { RerankerFn, RerankerLookup } from '../../base/ports/reranker.js';

/** What the rerankers reach past the process: the hosted ones send HTTP, the cross-encoder loads a model. */
export interface RerankerPorts {
  readonly http: Http;
  readonly crossEncoder: CrossEncoderLoad;
}

// Each reranker is built once per registry, so its outage warning lasts the registry's life; jev falls back to the same
// cross-encoder, so one model loads.
export function rerankerRegistry({ http, crossEncoder: loadModel }: RerankerPorts): RerankerLookup {
  const crossEncoder = createCrossEncoderReranker(loadModel);
  const registry = {
    clef: createClefReranker('clef', http),
    'clef-flash': createClefReranker('clef-flash', http),
    'cross-encoder': crossEncoder,
    jev: createJevReranker(crossEncoder, http),
    llm: createLlmReranker(http),
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

export type { RerankerFn, RerankerLookup, RerankResult, RerankerOptions } from '../../base/ports/reranker.js';
