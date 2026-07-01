/**
 * Pluggable embedding providers for Hippo.
 *
 * The local `@huggingface/transformers` path stays the zero-DEPENDENCY DEFAULT. Opt-in
 * API providers (OpenAI / Voyage / Cohere) let a user bring a frontier embedder
 * (e.g. text-embedding-3-large) for frontier-class retrieval. They use the native
 * `fetch` global (Node >= 22.5, see package.json engines — NO new dependency) and
 * read their key from a conventional env var. The provider is selected by
 * `config.embeddings.provider` (default `'local'`).
 *
 * Design contract (see docs/plans/2026-06-08-b-pluggable-embedding-provider.md):
 *   - Local provider `id` is the BARE model string, so existing stores whose DB
 *     meta `embedding_model` is `Xenova/all-MiniLM-L6-v2` see NO identity change
 *     and are NOT force-reindexed on upgrade.
 *   - API provider `id` is `${kind}:${model}`; switching to/from an API embedder
 *     (or a dimension change) flips the identity and triggers the existing
 *     reindex-on-change path.
 *   - `resolveEmbeddingProvider` NEVER throws. `isAvailable()` is provider-aware
 *     (local -> dependency installed; api -> key present). `embed()` MAY throw on
 *     a hard transport/auth failure so a reindex can abort atomically; hot paths
 *     wrap it and fall back to BM25.
 *
 * The exact request/response shapes for the API providers are documented from each
 * vendor's public embeddings API; they are unit-tested here against a mocked
 * `fetch` and are integration-verified in Workstream C (real API calls are
 * egress-blocked in the build sandbox).
 */

import {
  type EmbeddingRole,
  getEmbedding,
  isEmbeddingAvailable,
  resolveEmbeddingModel,
  DEFAULT_EMBEDDING_MODEL,
} from './embeddings.js';
import { loadConfig } from './config.js';

export type EmbeddingProviderKind = 'local' | 'openai' | 'voyage' | 'cohere';

export const API_PROVIDER_KINDS: readonly EmbeddingProviderKind[] = ['openai', 'voyage', 'cohere'];

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
    // Sequential to preserve the historical single-pipeline behaviour and avoid
    // contending the one cached pipeline instance with N concurrent calls.
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

interface ApiProviderShape {
  keyEnv: string;
  defaultBaseUrl: string;
  /** Endpoint path appended to baseUrl ('embeddings' for OpenAI/Voyage, 'embed' for Cohere). */
  path: string;
  /** Provider flagship model, used when config selects the provider but no API model. */
  defaultModel: string;
  /** Build the POST body for a batch of texts. */
  buildBody(model: string, texts: string[], role?: EmbeddingRole): Record<string, unknown>;
  /** Extract the ordered vectors from the parsed JSON response. */
  extractVectors(json: unknown): number[][];
}

const API_SHAPES: Record<'openai' | 'voyage' | 'cohere', ApiProviderShape> = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    defaultBaseUrl: 'https://api.openai.com/v1',
    path: 'embeddings',
    defaultModel: 'text-embedding-3-large',
    // OpenAI has no asymmetric query/passage input type for embeddings.
    buildBody: (model, texts) => ({ model, input: texts }),
    extractVectors: (json) => {
      const data = (json as { data?: Array<{ embedding?: number[] }> }).data ?? [];
      return data.map((d) => d.embedding ?? []);
    },
  },
  voyage: {
    keyEnv: 'VOYAGE_API_KEY',
    defaultBaseUrl: 'https://api.voyageai.com/v1',
    path: 'embeddings',
    defaultModel: 'voyage-3',
    buildBody: (model, texts, role) => {
      const body: Record<string, unknown> = { model, input: texts };
      if (role) body.input_type = role === 'query' ? 'query' : 'document';
      return body;
    },
    extractVectors: (json) => {
      const data = (json as { data?: Array<{ embedding?: number[] }> }).data ?? [];
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
      const emb = (json as { embeddings?: { float?: number[][] } }).embeddings;
      return emb?.float ?? [];
    },
  },
};

/** Remove a secret substring from any string before it surfaces in an error. */
function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
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
    return API_SHAPES[this.kind].keyEnv;
  }

  isAvailable(): boolean {
    return this.enabled && !!process.env[this.keyEnv]?.trim();
  }

  async embed(texts: string[], role?: EmbeddingRole): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = process.env[this.keyEnv]?.trim();
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
    const shape = API_SHAPES[this.kind];
    const url = `${this.baseUrl.replace(/\/$/, '')}/${shape.path}`;
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(shape.buildBody(this.model, chunk, role)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`embedding request to ${this.kind} failed: ${msg}`, key));
    }

    if (!resp.ok) {
      let detail = '';
      try {
        detail = await resp.text();
      } catch {
        /* ignore body read error */
      }
      throw new Error(
        redact(`${this.kind} embeddings HTTP ${resp.status}: ${detail.slice(0, 300)}`, key),
      );
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redact(`${this.kind} embeddings returned invalid JSON: ${msg}`, key));
    }

    const vectors = shape.extractVectors(json);
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
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function readEmbeddingsConfig(hippoRoot: string): {
  enabled?: boolean | 'auto';
  provider?: string;
  model?: string;
  apiBaseUrl?: string;
  batchSize?: number;
} {
  try {
    return loadConfig(hippoRoot).embeddings;
  } catch {
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
  const requested = (opts.provider ?? cfg.provider ?? 'local') as string;
  // An explicit embeddings.enabled=false hard-disables embedding for BOTH local
  // and API providers — for API this prevents unwanted paid off-box calls.
  const enabled = cfg.enabled !== false;

  if (requested === 'local') {
    return new LocalEmbeddingProvider(resolveEmbeddingModel(hippoRoot, opts.model), enabled);
  }
  if (!API_PROVIDER_KINDS.includes(requested as EmbeddingProviderKind)) {
    // Fail loud on a typo'd provider rather than silently using local (which
    // would reindex with the local model and clobber the intended identity).
    throw new Error(
      `Unknown embeddings.provider '${requested}'. Valid values: local, ${API_PROVIDER_KINDS.filter((k) => k !== 'local').join(', ')}.`,
    );
  }

  const kind = requested as 'openai' | 'voyage' | 'cohere';
  const shape = API_SHAPES[kind];
  // If no API model was chosen (config left the local default in place), fall
  // back to the provider's flagship model rather than POSTing a local model id.
  const requestedModel = (opts.model ?? cfg.model)?.trim();
  const model =
    requestedModel && requestedModel !== DEFAULT_EMBEDDING_MODEL ? requestedModel : shape.defaultModel;
  const baseUrl = validateBaseUrl(cfg.apiBaseUrl, shape.defaultBaseUrl);
  const batchSize =
    typeof cfg.batchSize === 'number' && Number.isInteger(cfg.batchSize) && cfg.batchSize > 0
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
  } catch {
    // Invalid embedding config (e.g. an insecure apiBaseUrl) must not crash the
    // best-effort ingestion guard — treat it as "not configured" and skip.
    return false;
  }
}
