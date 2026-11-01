// The real outside services, built in one place: each composition root puts them in the Context
// it builds.
import type { InfraPorts, StoreRules } from '../base/ports/infra.js';
import type { Llm } from '../base/ports/llm.js';
import type { RerankerLookup } from '../base/ports/reranker.js';
import { envAnthropicApiKey, envFakeNowMs } from '../base/util/env.js';
import { evalClock } from './eval-switches.js';
import { anthropicLlm } from './anthropic-llm.js';
import { resolveEmbeddingProvider } from './embedding-provider.js';
import { createHost, type Host } from '../host/host.js';
import { currentMachine } from './machine.js';
import { realRerankers } from './rerankers/index.js';
import { readApiCalls } from './transcript-calls.js';
import { FailureNotices } from '../base/util/failure-notices.js';

/** The Llm ANTHROPIC_API_KEY opens, or undefined when the key is unset: with no key, no model
 * is called. */
export function anthropicLlmFromEnv(fetcher?: typeof fetch): Llm | undefined {
  const apiKey = envAnthropicApiKey();
  return apiKey ? anthropicLlm({ apiKey, fetcher }) : undefined;
}

/** What a root builds once and keeps: its rerankers, so the cross-encoder loads once, and its
 * warned failures. */
interface RootKept {
  readonly reranker: RerankerLookup;
  readonly failureNotices: FailureNotices;
}

/** The real ports over what the root keeps; the machine, the model and the clock read the
 * environment as each Context is built, and the machine walks projects through the root's `host`. */
function realInfra({ reranker, failureNotices }: RootKept, host: Host): InfraPorts {
  return {
    machine: currentMachine(host),
    llm: anthropicLlmFromEnv(),
    embedderFor: (embeddings, opts) => resolveEmbeddingProvider(embeddings, opts),
    reranker,
    transcriptCalls: readApiCalls,
    clock: evalClock(),
    failureNotices,
  };
}

/** What a root opens its store with: the production strength model at its
 * HIPPO_LOSS_AVERSION_RATIO, and HIPPO_FAKE_NOW. */
export function rootStoreRules(lossAversionRatio: number | undefined): StoreRules {
  return { lossAversionRatio, fakeNowMs: envFakeNowMs() };
}

/** A root's infra source: its rerankers are built on the first Context and kept, never once per
 * request, and its `host` keeps the project walks for the root's life. */
export function rootInfra(
  host: Host = createHost(),
  failureNotices = new FailureNotices(),
): () => InfraPorts {
  let rerankers: RerankerLookup | undefined;
  return () => realInfra({ reranker: (rerankers ??= realRerankers()), failureNotices }, host);
}
