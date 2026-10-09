/**
 * Pluggable embedding providers for Hippo.
 *
 * The local `@huggingface/transformers` path stays the zero-DEPENDENCY DEFAULT. Opt-in
 * API providers (OpenAI / Voyage / Cohere) let a user bring a frontier embedder
 * (e.g. text-embedding-3-large) for frontier-class retrieval. They use the native
 * `fetch` global (Node >= 22.16, see package.json engines; NO new dependency) and
 * read their key from a conventional env var. The provider is selected by
 * `config.embeddings.provider` (default `'local'`).
 *
 * Design contract:
 *   - Local provider `id` is the BARE model string; the STORED identity adds a `#t<N>`
 *     embed-text-format suffix (`embeddingIndexIdentity`), so older stores reindex once:
 *     their vectors were computed over path-contaminated text.
 *   - API provider `id` is `${kind}:${model}`; switching to/from an API embedder
 *     (or a dimension change) flips the identity and triggers the existing
 *     reindex-on-change path.
 *   - `resolveEmbeddingProvider` throws on an invalid config (unknown provider,
 *     bad apiBaseUrl); `embedMemory` turns that into a warning. `isAvailable()` is provider-aware
 *     (local -> dependency installed; api -> key present). `embed()` MAY throw on
 *     a hard transport/auth failure so a reindex can abort atomically; hot paths
 *     wrap it and fall back to BM25.
 *
 * The exact request/response shapes for the API providers are documented from each
 * vendor's public embeddings API; they are unit-tested here against a mocked
 * `fetch` and are integration-verified in Workstream C (real API calls are
 * egress-blocked in the build sandbox).
 */

import { envByName } from '../../util/env.js';
import {
  type EmbeddingRole,
  getEmbedding,
  isEmbeddingAvailable,
  requireLocalPipeline,
  resolveEmbeddingModel,
  DEFAULT_EMBEDDING_MODEL,
} from './local.js';
import { loadConfig } from '../../core/config.js';
import { errorMessage, log } from '../../util/log.js';
import { redactSecretsStrict } from '../../util/secret-detect.js';
import { fetchWithRetry } from '../../util/http-retry.js';
import type { JsonValue } from '../../util/json.js';
import { readCappedJson, readCappedText } from '../../util/capped-json.js';

const ERROR_DETAIL_CHARS = 300;
// An error body is read for its first lines only; 4x leaves room for multi-byte text.
const ERROR_BODY_MAX_BYTES = ERROR_DETAIL_CHARS * 4;
// 16,384 dimensions at 32 bytes a number: four times a 4,096-dimension model.
const EMBED_REPLY_BYTES_PER_INPUT = 512 * 1024;
const EMBED_REPLY_BASE_BYTES = 64 * 1024;

export type EmbeddingProviderKind = 'local' | 'openai' | 'voyage' | 'cohere';

export const API_PROVIDER_KINDS: readonly EmbeddingProviderKind[] = ['openai', 'voyage', 'cohere'];

function isApiProviderKind(x: string): x is 'openai' | 'voyage' | 'cohere' {
  return x === 'openai' || x === 'voyage' || x === 'cohere';
}

const DEFAULT_API_BATCH_SIZE = 64;
/** Per-request timeout for API embedding calls. A provider/proxy that accepts
 *  the connection but never responds must not hang embed/recall indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface EmbeddingProvider {
  readonly kind: EmbeddingProviderKind;
  readonly model: string;
  /**
   * Identity recorded in DB meta to drive reindex-on-change.
   * local -> bare model string (back-compat); api -> `${kind}:${model}`.
   */
  readonly id: string;
  /** Known fixed output dimension, if any (undefined for local / unknown). */
  readonly dimensions?: number;
  /** Env var holding this provider's API key (undefined for the local provider). */
  readonly keyEnv?: string;
  /** local -> dependency installed; api -> key present. NEVER throws. */
  isAvailable(): boolean;
  /**
   * Batch-embed. Returns one row per input in order; a row is `[]` when that
   * single item could not be embedded. MAY throw on a hard transport/auth
   * failure (so a reindex aborts before saving a partial index).
   */
  embed(texts: string[], role?: EmbeddingRole): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Local provider — wraps the existing zero-dep transformers.js path.
// ---------------------------------------------------------------------------

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'local' as const;
  constructor(readonly model: string, private readonly enabled: boolean = true) {}
  get id(): string {
    return this.model;
  }
  isAvailable(): boolean {
    return this.enabled && isEmbeddingAvailable();
  }
  async embed(texts: string[], role?: EmbeddingRole): Promise<number[][]> {
    // A model that cannot load fails the call, as an API outage does; items then run one at a time on the shared pipeline.
    if (texts.length > 0) await requireLocalPipeline(this.model);
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await getEmbedding(text, this.model, role));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// API providers — OpenAI / Voyage / Cohere over native fetch.
// ---------------------------------------------------------------------------

/** POST body for an embeddings request. Each provider's `buildBody` populates
 *  only the fields its API expects; the rest stay unset. */
interface EmbeddingRequestBody {
  model: string;
  input?: string[];
  input_type?: string;
  texts?: string[];
  embedding_types?: string[];
}

/** OpenAI and Voyage both respond `{ data: [{ embedding: number[] }] }`. */
interface VectorArrayResponse {
  data?: Array<{ embedding?: number[] }>;
}

/** Cohere v2: `{ embeddings: { float: number[][] } }`. */
interface CohereEmbeddingsResponse {
  embeddings?: { float?: number[][] };
}

interface ApiProviderSpec {
  keyEnv: string;
  defaultBaseUrl: string;
  /** Endpoint path appended to baseUrl ('embeddings' for OpenAI/Voyage, 'embed' for Cohere). */
  path: string;
  /** Provider flagship model, used when config selects the provider but no API model. */
  defaultModel: string;
  /** Build the POST body for a batch of texts. */
  buildBody(model: string, texts: string[], role?: EmbeddingRole): EmbeddingRequestBody;
  /** Extract the ordered vectors from the parsed JSON response. */
  extractVectors(json: JsonValue): number[][];
}

const API_PROVIDER_SPECS = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    defaultBaseUrl: 'https://api.openai.com/v1',
    path: 'embeddings',
    defaultModel: 'text-embedding-3-large',
    // OpenAI has no asymmetric query/passage input type for embeddings.
    buildBody: (model, texts) => ({ model, input: texts }),
    extractVectors: (json) => {
      // SAFETY: OpenAI's documented embeddings response envelope; embedChunk
      // validates vector count/non-emptiness against the request afterward,
      // so a malformed response degrades to [] here and throws there.
      const data = (json as VectorArrayResponse).data ?? [];
      return data.map((d) => d.embedding ?? []);
    },
  },
  voyage: {
    keyEnv: 'VOYAGE_API_KEY',
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    path: 'embeddings',
    defaultModel: 'voyage-3',
    buildBody: (model, texts, role) => {
      const body: EmbeddingRequestBody = { model, input: texts };
      if (role) body.input_type = role === 'query' ? 'query' : 'document';
      return body;
    },
    extractVectors: (json) => {
      // SAFETY: Voyage's documented embeddings response envelope; embedChunk
      // validates vector count/non-emptiness against the request afterward,
      // so a malformed response degrades to [] here and throws there.
      const data = (json as VectorArrayResponse).data ?? [];
      return data.map((d) => d.embedding ?? []);
    },
  },
  cohere: {
    keyEnv: 'COHERE_API_KEY',
    defaultBaseUrl: 'https://api.cohere.com/v2',
    path: 'embed',
    defaultModel: 'embed-v4.0',
    buildBody: (model, texts, role) => ({
      model,
      texts,
      input_type: role === 'query' ? 'search_query' : 'search_document',
      embedding_types: ['float'],
    }),
    extractVectors: (json) => {
      // Cohere v2: { embeddings: { float: number[][] } }
      // SAFETY: matches Cohere's documented v2 response envelope; embedChunk
      // validates vector count/non-emptiness against the request afterward,
      // so a malformed response degrades to [] here and throws there.
      const emb = (json as CohereEmbeddingsResponse).embeddings;
      return emb?.float ?? [];
    },
  },
} satisfies Record<'openai' | 'voyage' | 'cohere', ApiProviderSpec>;

/** Remove a secret substring from any string before it surfaces in an error. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

/** A cause with the key cut out: the caught error's own text or cause chain can echo the Authorization header. */
function redactedCause<E>(err: E, key: string | undefined): Error {
  const copy = new Error(redact(errorMessage(err), key));
  if (err instanceof Error) copy.name = err.name;
  return copy;
}

function l2normalize(v: number[]): number[] {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm < 1e-12) return v;
  return v.map((x) => x / norm);
}

class ApiEmbeddingProvider implements EmbeddingProvider {
  constructor(
    readonly kind: 'openai' | 'voyage' | 'cohere',
    readonly model: string,
    private readonly baseUrl: string,
    private readonly batchSize: number,
    private readonly enabled: boolean = true,
  ) {}

  get id(): string {
    return `${this.kind}:${this.model}`;
  }

  get keyEnv(): string {
    return API_PROVIDER_SPECS[this.kind].keyEnv;
  }

  isAvailable(): boolean {
    return this.enabled && !!envByName(this.keyEnv)?.trim();
  }

  async embed(texts: string[], role?: EmbeddingRole): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = envByName(this.keyEnv)?.trim();
    if (!key) {
      // Hard, actionable failure — never includes a key value (there is none).
      throw new Error(
        `Embedding provider '${this.kind}' is configured but ${this.keyEnv} is not set. ` +
          `Export ${this.keyEnv} or set config.embeddings.provider back to 'local'.`,
      );
    }

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const chunk = texts.slice(i, i + this.batchSize);
      const vecs = await this.embedChunk(chunk, key, role);
      for (const v of vecs) out.push(v.length > 0 ? l2normalize(v) : v);
    }
    return out;
  }

  private async embedChunk(chunk: string[], key: string, role?: EmbeddingRole): Promise<number[][]> {
    const spec = API_PROVIDER_SPECS[this.kind];
    const resp = await this.postChunk(chunk, key, role);
    const json = await this.responseJson(resp, key, chunk.length);

    const vectors = spec.extractVectors(json);
    // A 200 response with the wrong number of vectors (or any empty/malformed
    // vector) is a provider/proxy contract violation, NOT a per-item miss. Throw
    // so a reindex aborts atomically (preserving the prior usable index) and the
    // explicit backfill surfaces it, instead of silently saving []-padded rows.
    if (vectors.length !== chunk.length) {
      throw new Error(
        redact(`${this.kind} embeddings returned ${vectors.length} vectors for ${chunk.length} inputs`, key),
      );
    }
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i] || vectors[i].length === 0) {
        throw new Error(redact(`${this.kind} embeddings returned an empty vector at index ${i}`, key));
      }
    }
    return vectors;
  }

  private async postChunk(chunk: string[], key: string, role?: EmbeddingRole): Promise<Response> {
    const spec = API_PROVIDER_SPECS[this.kind];
    const url = `${this.baseUrl.replace(/\/$/, '')}/${spec.path}`;
    try {
      return await fetchWithRetry(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(spec.buildBody(this.model, chunk.map(redactSecretsStrict), role)),
      }, { timeoutMs: REQUEST_TIMEOUT_MS });
    } catch (err) {
      const msg = errorMessage(err);
      throw new Error(redact(`embedding request to ${this.kind} failed: ${msg}`, key), { cause: redactedCause(err, key) });
    }
  }

  /** The body of an OK reply; any other status, or a body that is not JSON, throws with the key cut out. */
  private async responseJson(resp: Response, key: string, inputs: number): Promise<JsonValue> {
    if (!resp.ok) {
      let detail = '';
      try {
        detail = await readCappedText(resp, ERROR_BODY_MAX_BYTES);
      } catch {
        /* ignore body read error */
      }
      throw new Error(
        redact(`${this.kind} embeddings HTTP ${resp.status}: ${detail.slice(0, ERROR_DETAIL_CHARS)}`, key),
      );
    }

    try {
      return await readCappedJson(resp, EMBED_REPLY_BASE_BYTES + inputs * EMBED_REPLY_BYTES_PER_INPUT);
    } catch (err) {
      const msg = errorMessage(err);
      throw new Error(redact(`${this.kind} embeddings returned invalid JSON: ${msg}`, key), { cause: redactedCause(err instanceof Error && err.cause ? err.cause : err, key) });
    }
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface EmbeddingsConfigValues {
  enabled?: boolean | 'auto';
  provider?: string;
  model?: string;
  apiBaseUrl?: string;
  batchSize?: number;
}

function readEmbeddingsConfig(hippoRoot: string): EmbeddingsConfigValues {
  try {
    return loadConfig(hippoRoot).embeddings;
  } catch {
    // An unreadable config falls back to provider defaults; loadConfig warns on a bad parse.
    return {};
  }
}

/** Validate a user-supplied API base URL: HTTPS only (or explicit localhost). */
function validateBaseUrl(url: string | undefined, fallback: string): string {
  const candidate = url?.trim();
  if (!candidate) return fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`config.embeddings.apiBaseUrl is not a valid URL: ${candidate}`);
  }
  const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocalhost) {
    throw new Error(
      `config.embeddings.apiBaseUrl must use https (got ${parsed.protocol}//${parsed.hostname}). ` +
        `Plaintext http is only allowed for localhost.`,
    );
  }
  return candidate;
}

export interface ResolveProviderOptions {
  /** Explicit model override (mirrors resolveEmbeddingModel's explicitModel). */
  model?: string;
  /** Explicit provider override (mainly for tests). */
  provider?: EmbeddingProviderKind;
}

/**
 * Build the active embedding provider from config (or an explicit override).
 * Never throws for a missing key — that surfaces via `isAvailable()` on the hot
 * paths and as a hard error only from the explicit `hippo embed` command. The
 * only hard throw is an invalid config (e.g. an insecure apiBaseUrl), a
 * deliberate loud failure; hot-path callers (search) wrap this in try/catch.
 */
export function resolveEmbeddingProvider(
  hippoRoot: string,
  opts: ResolveProviderOptions = {},
): EmbeddingProvider {
  const cfg = readEmbeddingsConfig(hippoRoot);
  const requested = opts.provider ?? cfg.provider ?? 'local';
  // An explicit embeddings.enabled=false hard-disables embedding for BOTH local
  // and API providers — for API this prevents unwanted paid off-box calls.
  const enabled = cfg.enabled !== false;

  if (requested === 'local') {
    return new LocalEmbeddingProvider(resolveEmbeddingModel(hippoRoot, opts.model), enabled);
  }
  if (!isApiProviderKind(requested)) {
    // Fail loud on a typo'd provider rather than silently using local (which
    // would reindex with the local model and clobber the intended identity).
    throw new Error(
      `Unknown embeddings.provider '${requested}'. Valid values: local, ${API_PROVIDER_KINDS.filter((k) => k !== 'local').join(', ')}.`,
    );
  }

  const kind = requested;
  const spec = API_PROVIDER_SPECS[kind];
  // If no API model was chosen (config left the local default in place), fall
  // back to the provider's flagship model rather than POSTing a local model id.
  const requestedModel = (opts.model ?? cfg.model)?.trim();
  const model =
    requestedModel && requestedModel !== DEFAULT_EMBEDDING_MODEL ? requestedModel : spec.defaultModel;
  const baseUrl = validateBaseUrl(cfg.apiBaseUrl, spec.defaultBaseUrl);
  const batchSize =
    cfg.batchSize !== undefined && Number.isInteger(cfg.batchSize) && cfg.batchSize > 0
      ? cfg.batchSize
      : DEFAULT_API_BATCH_SIZE;
  return new ApiEmbeddingProvider(kind, model, baseUrl, batchSize, enabled);
}

/**
 * The reindex identity for the active provider. Use this (NOT resolveEmbeddingModel)
 * everywhere `embeddingModelRequiresReindex` / stored-model comparisons happen.
 */
export function resolveEmbeddingIdentity(hippoRoot: string, opts: ResolveProviderOptions = {}): string {
  return resolveEmbeddingProvider(hippoRoot, opts).id;
}

/**
 * Provider-aware availability for a store: local -> dependency installed;
 * api -> key present. Use at the call sites that decide whether to embed.
 */
export function isEmbeddingConfigured(hippoRoot: string): boolean {
  try {
    return resolveEmbeddingProvider(hippoRoot).isAvailable();
  } catch (err) {
    // An invalid embedding config must not crash the best-effort ingestion guard, so it reads as not configured.
    log.debug(`embedding config unusable: ${errorMessage(err)}`);
    return false;
  }
}
