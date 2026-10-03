import { buildRelevanceRequest, JEV_DEFAULT_TOP_K } from './jev.js';
import type { RerankerFn, RerankResult, RerankerOptions, RerankProvenance } from './types.js';
import type { SearchResult } from '../search.js';
import { isJsonObjectRecord, type JsonValue } from '../http-util.js';

/** The two pretrained CLEF decision models served by Cloudflare Workers AI. */
export type ClefModel = 'clef-flash' | 'clef';

const CLEF_MODELS: readonly ClefModel[] = ['clef-flash', 'clef'];
const DEFAULT_TIMEOUT_MS = 15_000;
// Workers AI rejects a request with more than 64 questions, one per candidate here.
const MAX_CANDIDATES = 64;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/** True when `name` is one of the CLEF reranker names. */
export function isClefModel(name: string): name is ClefModel {
  return CLEF_MODELS.some((m) => m === name);
}

interface ClefRoute {
  url: string;
  token: string | undefined;
  backend: 'cloudflare' | 'private-endpoint';
}

interface ClefScores {
  scores: number[];
  actualModel?: string;
  inputTokens?: number;
  outputTokens?: number;
}

function isNumber(v: JsonValue | undefined): v is number {
  return Number.isFinite(v);
}

function isString(v: JsonValue | undefined): v is string {
  return v !== undefined && v !== null && v.constructor === String;
}

function isRejection(v: ClefScores | string): v is string {
  return typeof v === 'string';
}

/** Transport from trusted local env, never call arguments: HIPPO_CLEF_ENDPOINT wins over hosted Workers AI. */
export function resolveClefRoute(model: ClefModel): ClefRoute {
  const endpoint = process.env.HIPPO_CLEF_ENDPOINT?.trim();
  if (endpoint) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error('HIPPO_CLEF_ENDPOINT is not a valid URL');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('HIPPO_CLEF_ENDPOINT must be an http or https URL');
    }
    return { url: parsed.href, token: process.env.HIPPO_CLEF_ENDPOINT_TOKEN?.trim() || undefined, backend: 'private-endpoint' };
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ?? '';
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim() ?? '';
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN not set');
  if (!ACCOUNT_ID.test(account)) throw new Error('CLOUDFLARE_ACCOUNT_ID is not a 32-character hex id');
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`,
    token,
    backend: 'cloudflare',
  };
}

/** Unwraps a Workers AI `{ result }` envelope or a bare System One reply and checks model and `c1..cN`; a string is the rejection reason. */
export function parseClefReply(body: JsonValue, n: number, model: ClefModel, requireModel: boolean): ClefScores | string {
  if (!isJsonObjectRecord(body)) return 'reply is not a JSON object';
  if (body.success === false) return 'provider reported failure';
  const reply = body.result === undefined ? body : body.result;
  if (!isJsonObjectRecord(reply)) return 'reply has no result object';

  const actual = reply.model;
  if (actual !== undefined && (!isString(actual) || actual.trim() !== model)) return 'reply names a different model';
  if (actual === undefined && requireModel) return 'reply does not name its model';

  const answers = reply.answers;
  if (!isJsonObjectRecord(answers)) return 'reply has no answers';
  if (Object.keys(answers).length !== n) return 'incomplete or out-of-range answers';
  const scores: number[] = [];
  for (let i = 1; i <= n; i++) {
    const a = answers[`c${i}`];
    if (!isJsonObjectRecord(a) || (a.type !== undefined && a.type !== 'noul')) return 'incomplete or out-of-range answers';
    const v = a.noul;
    if (!isNumber(v) || v < 0 || v > 1) return 'incomplete or out-of-range answers';
    scores.push(v);
  }

  const usage = isJsonObjectRecord(reply.usage) ? reply.usage : {};
  return {
    scores,
    actualModel: isString(actual) ? actual.trim() : undefined,
    inputTokens: isNumber(usage.input_tokens) ? usage.input_tokens : undefined,
    outputTokens: isNumber(usage.output_tokens) ? usage.output_tokens : undefined,
  };
}

async function requestScores(model: ClefModel, query: string, head: SearchResult[], route: ClefRoute): Promise<ClefScores> {
  const { state, questions } = buildRelevanceRequest(query, head);
  const parsedTimeout = Number.parseInt(process.env.HIPPO_CLEF_TIMEOUT_MS ?? '', 10);
  const timeoutMs = parsedTimeout > 0 ? parsedTimeout : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers({ 'content-type': 'application/json' });
  if (route.token) headers.set('authorization', `Bearer ${route.token}`);
  try {
    const resp = await fetch(route.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      // A third-party header ends up on stderr, so keep printable ASCII only.
      const ray = resp.headers.get('cf-ray')?.replace(/[^\x20-\x7e]/g, '').slice(0, 64);
      await resp.body?.cancel();
      throw new Error(`HTTP ${resp.status}${ray ? `, ray ${ray}` : ''}`);
    }
    const body: JsonValue = await resp.json();
    const parsed = parseClefReply(body, head.length, model, route.backend === 'cloudflare');
    if (isRejection(parsed)) throw new Error(parsed);
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`no answer within ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** The input order, unchanged, with the reason recorded. Never a partial reorder. */
function nativeOrder(head: SearchResult[], provenance: RerankProvenance): RerankResult[] {
  return head.map((r, i) => ({
    ...r,
    rerankScore: r.score,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
    rerankProvenance: provenance,
  }));
}

/** A CLEF reranker for one model: Jev's request shape and pool; any failure keeps the native order (never paid Jev), warning once. */
export function createClefReranker(model: ClefModel): RerankerFn {
  let warned = false;
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? JEV_DEFAULT_TOP_K);
    if (head.length === 0) return [];

    let backend: RerankProvenance['backend'] = 'native';
    let got: ClefScores;
    try {
      if (head.length > MAX_CANDIDATES) throw new Error(`more than ${MAX_CANDIDATES} candidates`);
      const route = resolveClefRoute(model);
      backend = route.backend;
      got = await requestScores(model, query, head, route);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      if (!warned) {
        warned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[hippo] ${model} reranker unavailable (${reason}); keeping the native order. Subsequent calls will not repeat this warning.`,
        );
      }
      return nativeOrder(head, { backend: 'native', requestedModel: model, fallbackReason: reason });
    }

    const provenance: RerankProvenance = {
      backend,
      requestedModel: model,
      actualModel: got.actualModel,
      inputTokens: got.inputTokens,
      outputTokens: got.outputTokens,
    };
    const scored = head.map((r, i) => ({
      ...r,
      rerankScore: got.scores[i],
      preRerankRank: r.preRerankRank ?? i + 1,
      postRerankRank: 0,
      rerankProvenance: provenance,
    }));
    // Stable sort: ties fall back to the prior relevance order.
    scored.sort((a, b) => b.rerankScore - a.rerankScore);
    scored.forEach((r, i) => (r.postRerankRank = i + 1));
    return scored;
  };
}

/** Opt-in CLEF-flash reranker (Cloudflare Workers AI or HIPPO_CLEF_ENDPOINT). Docs: docs/evals/2026-09-19-jev-reranker.md. */
export const clefFlashReranker: RerankerFn = createClefReranker('clef-flash');

/** Opt-in CLEF reranker, the larger model. Same transport and fallback as clef-flash. */
export const clefReranker: RerankerFn = createClefReranker('clef');
