import {
  envAnthropicApiKey,
  envLlmAllowHttp,
  envLlmApiKey,
  envLlmBaseUrl,
  envLlmModel,
} from '../base/util/env.js';
import { errorMessage } from '../base/util/log.js';
import { checkHeaderSafe, parseOutboundUrl } from '../base/util/net.js';
import type { ChatEndpoint } from './openai-chat-llm.js';

export type LlmRoute =
  | {
      readonly kind: 'endpoint';
      readonly endpoint: string;
      readonly model: string;
      readonly plainHttp: boolean;
    }
  | { readonly kind: 'anthropic' }
  | { readonly kind: 'off' }
  | { readonly kind: 'refused'; readonly reason: string };

type EndpointRoute = Extract<LlmRoute, { kind: 'endpoint' }>;

/** The route and what the adapter needs to follow it; a key never rides in the route. */
export type LlmChoice =
  | { readonly route: EndpointRoute; readonly endpoint: Omit<ChatEndpoint, 'fetcher'> }
  | { readonly route: { readonly kind: 'anthropic' }; readonly anthropicKey: string }
  | { readonly route: Exclude<LlmRoute, { kind: 'endpoint' | 'anthropic' }> };

const refused = (reason: string): LlmChoice => ({ route: { kind: 'refused', reason } });

function keyProblem(name: string, key: string): string | undefined {
  try {
    checkHeaderSafe(name, key);
    return undefined;
  } catch (err) {
    return errorMessage(err);
  }
}

function readEndpointChoice(base: string): LlmChoice {
  let url: URL;
  try {
    url = parseOutboundUrl(base, {
      setting: 'HIPPO_LLM_BASE_URL',
      keySetting: 'HIPPO_LLM_API_KEY',
      allowHttp: envLlmAllowHttp(),
      allowHttpSetting: 'HIPPO_LLM_ALLOW_HTTP',
    });
  } catch (err) {
    return refused(errorMessage(err));
  }
  if (url.search !== '' || url.hash !== '') {
    return refused('HIPPO_LLM_BASE_URL must not carry a query or a fragment');
  }
  const model = envLlmModel();
  if (model === undefined) {
    return refused('HIPPO_LLM_MODEL is required when HIPPO_LLM_BASE_URL is set');
  }
  const apiKey = envLlmApiKey();
  const problem = apiKey === undefined ? undefined : keyProblem('HIPPO_LLM_API_KEY', apiKey);
  if (problem !== undefined) return refused(problem);
  const endpoint = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  return {
    route: { kind: 'endpoint', endpoint, model, plainHttp: url.protocol === 'http:' },
    endpoint: { baseUrl: url, model, apiKey },
  };
}

/** The route the environment picks, with the settings its adapter needs. */
export function readLlmChoice(): LlmChoice {
  const base = envLlmBaseUrl();
  if (base !== undefined) return readEndpointChoice(base);
  if (envLlmModel() !== undefined || envLlmApiKey() !== undefined) {
    return refused(
      'HIPPO_LLM_MODEL or HIPPO_LLM_API_KEY is set but HIPPO_LLM_BASE_URL is not; set it, or unset both',
    );
  }
  const anthropicKey = envAnthropicApiKey();
  if (anthropicKey === undefined) return { route: { kind: 'off' } };
  const problem = keyProblem('ANTHROPIC_API_KEY', anthropicKey);
  return problem === undefined ? { route: { kind: 'anthropic' }, anthropicKey } : refused(problem);
}

/** Where this process sends memory text for its model calls, without a key. */
export function llmRoute(): LlmRoute {
  return readLlmChoice().route;
}
