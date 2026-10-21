import type { ClefSettings } from '../../base/config/config.js';
import type { Http } from '../../base/ports/http.js';
import { buildRelevanceRequest, JEV_DEFAULT_TOP_K, rankByScores } from './jev.js';
import type { RerankerFn, RerankResult, RerankerOptions, RerankProvenance } from './types.js';
import type { SearchResult } from '../../base/rank/search-types.js';
import { createOutageWarning } from './outage-warning.js';
import { rerankerPost } from './remote.js';
import { readCappedJson } from '../../base/util/capped-json.js';
import { MAX_REPLY_BYTES } from '../../base/util/limits.js';
import { type JsonValue, isJsonObject, isJsonString } from '../../base/util/json.js';
import { errorFields, errorMessage } from '../../base/util/log.js';
import { parseOutboundUrl } from '../../base/util/net.js';

const RAY_ID_MAX_CHARS = 64;

/** The two pretrained CLEF decision models served by Cloudflare Workers AI. */
export type ClefModel = 'clef-flash' | 'clef';

const CLEF_MODELS: readonly ClefModel[] = ['clef-flash', 'clef'];
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
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
  backend: Exclude<RerankProvenance['backend'], 'native'>;
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

function isRejection(v: ClefScores | string): v is string {
  return v.constructor === String;
}

// fetch quotes a rejected header value in its error, so a token it would reject must never reach it.
function checkHeaderSafe(name: string, token: string): void {
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error(`${name} has characters a header cannot carry`);
}

/** Transport from the root's settings, never a request's: HIPPO_CLEF_ENDPOINT wins over hosted Workers AI. */
export function resolveClefRoute(model: ClefModel, settings: ClefSettings | undefined): ClefRoute {
  const endpoint = settings?.endpoint;
  if (endpoint) {
    const parsed = parseOutboundUrl(endpoint, 'HIPPO_CLEF_ENDPOINT', 'HIPPO_CLEF_ENDPOINT_TOKEN');
    const endpointToken = settings?.endpointToken;
    if (endpointToken) checkHeaderSafe('HIPPO_CLEF_ENDPOINT_TOKEN', endpointToken);
    return { url: parsed.href, token: endpointToken, backend: 'private-endpoint' };
  }
  const account = settings?.cloudflareAccountId;
  const token = settings?.cloudflareApiToken;
  if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN not set');
  if (!ACCOUNT_ID.test(account)) throw new Error('CLOUDFLARE_ACCOUNT_ID is not a 32-character hex id');
  checkHeaderSafe('CLOUDFLARE_API_TOKEN', token);
  return {
    url: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`,
    token,
    backend: 'cloudflare',
  };
}

/**
 * Unwraps a Workers AI `{ result }` envelope or a bare System One reply and checks model and `c1..cN`; a string is the
 * rejection reason.
 */
export function parseClefReply(
  body: JsonValue,
  n: number,
  model: ClefModel,
  requireModel: boolean,
): ClefScores | string {
  if (!isJsonObject(body)) return 'reply is not a JSON object';
  if (body.success === false) return 'provider reported failure';
  const reply = body.result === undefined ? body : body.result;
  if (!isJsonObject(reply)) return 'reply has no result object';

  const actual = reply.model;
  if (actual !== undefined && (!isJsonString(actual) || actual.trim() !== model)) {
    return 'reply names a different model';
  }
  if (actual === undefined && requireModel) return 'reply does not name its model';

  const answers = reply.answers;
  if (!isJsonObject(answers)) return 'reply has no answers';
  if (Object.keys(answers).length !== n) return 'incomplete or out-of-range answers';
  const scores: number[] = [];
  for (let i = 1; i <= n; i++) {
    const a = answers[`c${i}`];
    if (!isJsonObject(a) || (a.type !== undefined && a.type !== 'noul')) return 'incomplete or out-of-range answers';
    const v = a.noul;
    if (!isNumber(v) || v < 0 || v > 1) return 'incomplete or out-of-range answers';
    scores.push(v);
  }

  const usage = isJsonObject(reply.usage) ? reply.usage : {};
  return {
    scores,
    actualModel: isJsonString(actual) ? actual.trim() : undefined,
    inputTokens: isNumber(usage.input_tokens) ? usage.input_tokens : undefined,
    outputTokens: isNumber(usage.output_tokens) ? usage.output_tokens : undefined,
  };
}

/** Where one scoring request goes and how: the transport, the model asked for, its route and the call's timeout. */
interface ClefCall {
  readonly http: Http;
  readonly model: ClefModel;
  readonly route: ClefRoute;
  readonly requestedTimeoutMs: number | undefined;
}

async function requestScores(call: ClefCall, query: string, head: SearchResult[]): Promise<ClefScores> {
  const { http, model, route, requestedTimeoutMs: requested } = call;
  const { state, questions } = buildRelevanceRequest(query, head);
  // Node clamps a delay past 2^31-1 to 1 ms.
  const timeoutMs = requested !== undefined && requested <= MAX_TIMEOUT_MS ? requested : DEFAULT_TIMEOUT_MS;
  const headers = new Headers({ 'content-type': 'application/json' });
  if (route.token) headers.set('authorization', `Bearer ${route.token}`);
  const request = { headers, body: JSON.stringify({ state, model, questions }) };
  const resp = await rerankerPost(http, route.url, request, timeoutMs);
  if (!resp.ok) {
    // A third-party header ends up on stderr, so keep printable ASCII only.
    const ray = resp.headers
      .get('cf-ray')
      ?.replace(/[^\x20-\x7e]/g, '')
      .slice(0, RAY_ID_MAX_CHARS);
    await resp.body?.cancel();
    throw new Error(`HTTP ${resp.status}${ray ? `, ray ${ray}` : ''}`);
  }
  const body = await readCappedJson(resp, MAX_REPLY_BYTES);
  const parsed = parseClefReply(body, head.length, model, route.backend === 'cloudflare');
  if (isRejection(parsed)) throw new Error(parsed);
  return parsed;
}

/** The input order, unchanged, with the reason recorded. Never a partial reorder. */
function nativeOrder(head: SearchResult[], provenance: RerankProvenance): RerankResult[] {
  return head.map((r, i) => ({
    ...r,
    rerankScore: r.score,
    preRerankRank: r.preRerankRank ?? i + 1,
    postRerankRank: i + 1,
    // A copy per row, so a caller editing one result cannot change another's provenance.
    rerankProvenance: { ...provenance },
  }));
}

/**
 * A CLEF reranker for one model: Jev's request shape and pool; any failure keeps the native order (never paid Jev) and
 * warns.
 */
export function createClefReranker(model: ClefModel, http: Http): RerankerFn {
  const outage = createOutageWarning(model, 'keeping the native order');
  return async (query, results, options?: RerankerOptions): Promise<RerankResult[]> => {
    const head = results.slice(0, options?.topK ?? JEV_DEFAULT_TOP_K);
    if (head.length === 0) return [];

    let route: ClefRoute;
    let got: ClefScores;
    try {
      if (head.length > MAX_CANDIDATES) throw new Error(`more than ${MAX_CANDIDATES} candidates`);
      route = resolveClefRoute(model, options?.clef);
      got = await requestScores({ http, model, route, requestedTimeoutMs: options?.clef?.timeoutMs }, query, head);
      outage.answered();
    } catch (err) {
      const reason = errorMessage(err);
      outage.failed(reason, errorFields(err));
      return nativeOrder(head, { backend: 'native', requestedModel: model, fallbackReason: reason });
    }

    const rerankProvenance: RerankProvenance = {
      backend: route.backend,
      requestedModel: model,
      actualModel: got.actualModel,
      inputTokens: got.inputTokens,
      outputTokens: got.outputTokens,
    };
    return rankByScores(head, got.scores).map((r) => ({ ...r, rerankProvenance: { ...rerankProvenance } }));
  };
}
