import type { InfraPorts } from '../base/ports/infra.js';
import type { Llm } from '../base/ports/llm.js';
import type { RerankerLookup } from '../base/ports/reranker.js';
import { evalClock, evalSwitches } from './eval-switches.js';
import { anthropicLlm } from './anthropic-llm.js';
import { readLlmChoice } from './llm-route.js';
import { openAiChatLlm } from './openai-chat-llm.js';
import { resolveEmbeddingProvider } from './embedding-provider.js';
import { createHost, type Host } from '../host/host.js';
import { currentMachine } from './machine.js';
import { realRerankers } from './rerankers/index.js';
import { readApiCalls } from './transcript-calls.js';
import { FailureNotices } from '../base/util/failure-notices.js';

/** The Llm the environment picks: the HIPPO_LLM_BASE_URL endpoint, else ANTHROPIC_API_KEY's;
 * undefined when neither is set, so no model is called. A refused setting gives an Llm whose every
 * call fails, never a fall back to Anthropic. */
export function llmFromEnv(fetcher?: typeof fetch): Llm | undefined {
  const choice = readLlmChoice();
  if ('endpoint' in choice) return openAiChatLlm({ ...choice.endpoint, fetcher });
  if ('anthropicKey' in choice) return anthropicLlm({ apiKey: choice.anthropicKey, fetcher });
  const { route } = choice;
  if (route.kind !== 'refused') return undefined;
  return { send: async () => ({ ok: false, failure: { kind: 'config', message: route.reason } }) };
}

interface RootKept {
  readonly reranker: RerankerLookup;
  readonly failureNotices: FailureNotices;
}

function realInfra({ reranker, failureNotices }: RootKept, host: Host): InfraPorts {
  return {
    machine: currentMachine(host),
    llm: llmFromEnv(),
    embedderFor: (embeddings, opts) => resolveEmbeddingProvider(embeddings, opts),
    reranker,
    transcriptCalls: readApiCalls,
    evalSwitches: evalSwitches(),
    clock: evalClock(),
    failureNotices,
  };
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
