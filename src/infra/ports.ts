// The real outside services, built in one place: a root puts them in its Context and the api falls back to them.
import type { InfraPorts } from '../base/ports/infra.js';
import type { Llm } from '../base/ports/llm.js';
import { envAnthropicApiKey } from '../base/util/env.js';
import { anthropicLlm } from './anthropic-llm.js';
import { resolveEmbeddingProvider } from './embedding-provider.js';
import { currentMachine } from './machine.js';

/** The Llm ANTHROPIC_API_KEY opens, or undefined when the key is unset: with no key, no model is called. */
export function anthropicLlmFromEnv(fetcher?: typeof fetch): Llm | undefined {
  const apiKey = envAnthropicApiKey();
  return apiKey ? anthropicLlm({ apiKey, fetcher }) : undefined;
}

export function realInfra(): InfraPorts {
  return {
    machine: currentMachine(),
    llm: anthropicLlmFromEnv(),
    embedderFor: (embeddings, opts) => resolveEmbeddingProvider(embeddings, opts),
  };
}
