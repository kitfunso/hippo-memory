// The real outside services, built in one place: each composition root puts them in the Context it builds.
import type { InfraPorts } from '../base/ports/infra.js';
import type { Llm } from '../base/ports/llm.js';
import type { RerankerLookup } from '../base/ports/reranker.js';
import { envAnthropicApiKey } from '../base/util/env.js';
import { anthropicLlm } from './anthropic-llm.js';
import { resolveEmbeddingProvider } from './embedding-provider.js';
import { currentMachine } from './machine.js';
import { realRerankers } from './rerankers.js';

/** The Llm ANTHROPIC_API_KEY opens, or undefined when the key is unset: with no key, no model is called. */
export function anthropicLlmFromEnv(fetcher?: typeof fetch): Llm | undefined {
  const apiKey = envAnthropicApiKey();
  return apiKey ? anthropicLlm({ apiKey, fetcher }) : undefined;
}

/** The real ports over `reranker`; the machine and the model read the environment as each Context is built. */
export function realInfra(reranker: RerankerLookup): InfraPorts {
  return {
    machine: currentMachine(),
    llm: anthropicLlmFromEnv(),
    embedderFor: (embeddings, opts) => resolveEmbeddingProvider(embeddings, opts),
    reranker,
  };
}

/** A root's infra source: its rerankers are built on the first Context and kept, never once per request. */
export function rootInfra(): () => InfraPorts {
  let rerankers: RerankerLookup | undefined;
  return () => realInfra((rerankers ??= realRerankers()));
}

/** A Context with the real ports filled in when its builder set none, as a published entry takes one. */
export function withRealInfra<C extends { readonly infra?: InfraPorts }>(ctx: C, infra: () => InfraPorts): C {
  return ctx.infra === undefined ? { ...ctx, infra: infra() } : ctx;
}
