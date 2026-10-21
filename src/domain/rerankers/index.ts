import type { CrossEncoderLoad } from '../../base/ports/cross-encoder.js';
import type { Http } from '../../base/ports/http.js';
import { createClefReranker } from './clef.js';
import { createCrossEncoderReranker } from './cross-encoder.js';
import { createJevReranker } from './jev.js';
import { createLlmReranker } from './llm.js';
import type { RerankerFn } from './types.js';

/** What the rerankers reach past the process: the hosted ones send HTTP, the cross-encoder loads a model. */
export interface RerankerPorts {
  readonly http: Http;
  readonly crossEncoder: CrossEncoderLoad;
}

/** A named reranker, or null for no name; an unknown name throws with the names there are. */
export type RerankerLookup = (name: string | null | undefined) => RerankerFn | null;

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

export type { RerankerFn, RerankResult, RerankerOptions } from './types.js';
