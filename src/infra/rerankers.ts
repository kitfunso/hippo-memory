// The process's reranker registry over the real services: fetch for the hosted rerankers, Transformers.js for the
// cross-encoder. Built once, so each reranker's outage warning and model last the process.
import { rerankerRegistry, type RerankerLookup } from '../domain/rerankers/index.js';
import { transformersCrossEncoder } from './cross-encoder.js';
import { processHttp } from './http.js';

export const getReranker: RerankerLookup = rerankerRegistry({
  http: processHttp,
  crossEncoder: transformersCrossEncoder(),
});
