// The reranker registry over the real services: fetch for the hosted rerankers, Transformers.js for the cross-encoder.
import { rerankerRegistry, type RerankerLookup } from '../domain/rerankers/index.js';
import { transformersCrossEncoder } from './cross-encoder.js';
import { processHttp } from './http.js';

/** A new registry with its own cross-encoder: a root builds one and keeps it, so each model loads once. */
export function realRerankers(): RerankerLookup {
  return rerankerRegistry({ http: processHttp, crossEncoder: transformersCrossEncoder() });
}
