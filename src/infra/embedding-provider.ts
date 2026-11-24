import { DEFAULT_EMBEDDING_MODEL, resolveEmbeddingModel } from '../base/embeddings/local.js';
import type {
  EmbedCallOptions,
  EmbeddingProvider,
  EmbeddingProviderKind,
  EmbeddingRole,
} from '../base/ports/embedder.js';
import { envByName } from '../base/util/env.js';
import type { EmbeddingsConfig } from '../base/config/config.js';
import { errorMessage, log, errorFields } from '../base/util/log.js';
import { redactSecretsStrict } from '../base/util/secret-detect.js';
import type { JsonValue } from '../base/util/json.js';
import { readCappedJson, readCappedText } from '../base/util/capped-json.js';
import { parseOutboundUrl } from '../base/util/net.js';

import { ZERO_NORM, norm } from '../base/rank/cosine.js';
import { fetchWithRetry } from './http-retry.js';
import {
  createLocalEmbedder,
  type LocalEmbedder,
  type LocalTransformers,
  sharedLocalEmbedder,
} from './local-embedder.js';

const ERROR_DETAIL_CHARS = 300;
const ERROR_BODY_MAX_BYTES = ERROR_DETAIL_CHARS * 4;
const EMBED_REPLY_BYTES_PER_INPUT = 512 * 1024;
const EMBED_REPLY_BASE_BYTES = 64 * 1024;

export const API_PROVIDER_KINDS: readonly EmbeddingProviderKind[] = ['openai', 'voyage', 'cohere'];

function isApiProviderKind(x: string): x is 'openai' | 'voyage' | 'cohere' {
  return x === 'openai' || x === 'voyage' || x === 'cohere';
}

const DEFAULT_API_BATCH_SIZE = 64;
const REQUEST_TIMEOUT_MS = 30_000;
const DEADLINE_RETRY_WAIT_CAP_MS = 2_000;

class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'local' as const;
  constructor(
    readonly model: string,
    private readonly enabled: boolean,
    private readonly embedder: LocalEmbedder,
  ) {}
  get id(): string {
    return this.model;
  }
  isAvailable(): boolean {
    return this.enabled && this.embedder.isAvailable();
  }
  async embed(
    texts: string[],
    role?: EmbeddingRole,
    call: EmbedCallOptions = {},
  ): Promise<number[][]> {
    if (texts.length > 0) await this.embedder.requirePipeline(this.model, call.signal);
    const out: number[][] = [];
    for (const text of texts) {
      out.push(await this.embedder.embed(text, this.model, role));
    }
    return out;
  }
}

interface EmbeddingRequestBody {
  model: string;
  input?: string[];
  input_type?: string;
  texts?: string[];
  embedding_types?: string[];
}

interface VectorArrayResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface CohereEmbeddingsResponse {
  embeddings?: { float?: number[][] };
}

interface ApiProviderSpec {
  keyEnv: string;
  defaultBaseUrl: string;
  path: string;
  defaultModel: string;
  buildBody(model: string, texts: string[], role?: EmbeddingRole): EmbeddingRequestBody;
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
      // SAFETY: OpenAI's documented embeddings envelope; embedChunk validates vector count and
      // non-emptiness afterward, so a malformed response degrades to [] here and throws there.
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
      // SAFETY: Voyage's documented embeddings envelope; embedChunk validates vector count and
      // non-emptiness afterward, so a malformed response degrades to [] here and throws there.
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
      // SAFETY: documented v2 envelope; embedChunk validates the vectors afterward, so a malformed response degrades to
      // [] here and throws there.
      const emb = (json as CohereEmbeddingsResponse).embeddings;
      return emb?.float ?? [];
    },
  },
} satisfies Record<'openai' | 'voyage' | 'cohere', ApiProviderSpec>;

function redact(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('***');
}

function redactedCause<E>(err: E, key: string | undefined): Error {
  const copy = new Error(redact(errorMessage(err), key));
  if (err instanceof Error) copy.name = err.name;
  return copy;
}

function l2normalize(v: number[]): number[] {
  const length = norm(v);
  if (length < ZERO_NORM) return v;
  return v.map((x) => x / length);
}

interface ApiProviderSettings {
  readonly kind: 'openai' | 'voyage' | 'cohere';
  readonly model: string;
  readonly baseUrl: string;
  readonly batchSize: number;
  readonly enabled: boolean;
}

class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly kind: 'openai' | 'voyage' | 'cohere';
  readonly model: string;

  constructor(private readonly settings: ApiProviderSettings) {
    this.kind = settings.kind;
    this.model = settings.model;
  }

  get id(): string {
    return `${this.kind}:${this.model}`;
  }

  get keyEnv(): string {
    return API_PROVIDER_SPECS[this.kind].keyEnv;
  }

  isAvailable(): boolean {
    return this.settings.enabled && !!envByName(this.keyEnv)?.trim();
  }

  async embed(
    texts: string[],
    role?: EmbeddingRole,
    call: EmbedCallOptions = {},
  ): Promise<number[][]> {
    if (texts.length === 0) return [];
    const key = envByName(this.keyEnv)?.trim();
    if (!key) {
      throw new Error(
        `Embedding provider '${this.kind}' is configured but ${this.keyEnv} is not set. ` +
          `Export ${this.keyEnv} or set config.embeddings.provider back to 'local'.`,
      );
    }

    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.settings.batchSize) {
      const chunk = texts.slice(i, i + this.settings.batchSize);
      const vecs = await this.embedChunk(chunk, key, role, call.signal);
      for (const v of vecs) out.push(v.length > 0 ? l2normalize(v) : v);
    }
    return out;
  }

  private async embedChunk(
    chunk: string[],
    key: string,
    role?: EmbeddingRole,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    const spec = API_PROVIDER_SPECS[this.kind];
    const resp = await this.postChunk(chunk, key, role, signal);
    const json = await this.responseJson(resp, key, chunk.length);

    const vectors = spec.extractVectors(json);
    if (vectors.length !== chunk.length) {
      throw new Error(
        redact(
          `${this.kind} embeddings returned ${vectors.length} vectors for ${chunk.length} inputs`,
          key,
        ),
      );
    }
    for (let i = 0; i < vectors.length; i++) {
      if (!vectors[i] || vectors[i].length === 0) {
        throw new Error(
          redact(`${this.kind} embeddings returned an empty vector at index ${i}`, key),
        );
      }
    }
    return vectors;
  }

  private async postChunk(
    chunk: string[],
    key: string,
    role?: EmbeddingRole,
    signal?: AbortSignal,
  ): Promise<Response> {
    const spec = API_PROVIDER_SPECS[this.kind];
    const url = `${this.settings.baseUrl.replace(/\/$/, '')}/${spec.path}`;
    try {
      return await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(spec.buildBody(this.model, chunk.map(redactSecretsStrict), role)),
          signal,
        },
        {
          timeoutMs: REQUEST_TIMEOUT_MS,
          retryTransport: true,
          maxDelayMs: signal ? DEADLINE_RETRY_WAIT_CAP_MS : undefined,
        },
      );
    } catch (err) {
      const msg = errorMessage(err);
      throw new Error(redact(`embedding request to ${this.kind} failed: ${msg}`, key), {
        cause: redactedCause(err, key),
      });
    }
  }

  private async responseJson(resp: Response, key: string, inputs: number): Promise<JsonValue> {
    if (!resp.ok) {
      let detail = '';
      try {
        detail = await readCappedText(resp, ERROR_BODY_MAX_BYTES);
      } catch (err) {
        log.debug(
          `${this.kind} embeddings error body unreadable: ${errorMessage(err)}`,
          errorFields(err),
        );
      }
      throw new Error(
        redact(
          `${this.kind} embeddings HTTP ${resp.status}: ${detail.slice(0, ERROR_DETAIL_CHARS)}`,
          key,
        ),
      );
    }

    try {
      return await readCappedJson(
        resp,
        EMBED_REPLY_BASE_BYTES + inputs * EMBED_REPLY_BYTES_PER_INPUT,
      );
    } catch (err) {
      const msg = errorMessage(err);
      throw new Error(redact(`${this.kind} embeddings returned invalid JSON: ${msg}`, key), {
        cause: redactedCause(err instanceof Error && err.cause ? err.cause : err, key),
      });
    }
  }
}

function validateBaseUrl(url: string | undefined, fallback: string): string {
  const candidate = url?.trim();
  if (!candidate) return fallback;
  parseOutboundUrl(candidate, { setting: 'config.embeddings.apiBaseUrl' });
  return candidate;
}

export interface ResolveProviderOptions {
  model?: string;
  provider?: EmbeddingProviderKind;
  transformers?: LocalTransformers;
}

/** Build the active embedding provider from config (or an explicit override). A missing key
 * never throws here (it surfaces via `isAvailable()`); only an invalid config (e.g. insecure
 * apiBaseUrl) throws, deliberately loud, so hot-path callers wrap it. */
export function resolveEmbeddingProvider(
  cfg: EmbeddingsConfig,
  opts: ResolveProviderOptions = {},
): EmbeddingProvider {
  const requested = opts.provider ?? cfg.provider ?? 'local';
  const enabled = cfg.enabled !== false;

  if (requested === 'local') {
    const embedder = opts.transformers
      ? createLocalEmbedder(opts.transformers)
      : sharedLocalEmbedder;
    return new LocalEmbeddingProvider(resolveEmbeddingModel(cfg, opts.model), enabled, embedder);
  }
  if (!isApiProviderKind(requested)) {
    throw new Error(
      `Unknown embeddings.provider '${requested}'. Valid values: local, ` +
        `${API_PROVIDER_KINDS.filter((k) => k !== 'local').join(', ')}.`,
    );
  }

  const kind = requested;
  const spec = API_PROVIDER_SPECS[kind];
  const requestedModel = (opts.model ?? cfg.model)?.trim();
  const model =
    requestedModel && requestedModel !== DEFAULT_EMBEDDING_MODEL
      ? requestedModel
      : spec.defaultModel;
  const baseUrl = validateBaseUrl(cfg.apiBaseUrl, spec.defaultBaseUrl);
  const batchSize =
    cfg.batchSize !== undefined && Number.isInteger(cfg.batchSize) && cfg.batchSize > 0
      ? cfg.batchSize
      : DEFAULT_API_BATCH_SIZE;
  return new ApiEmbeddingProvider({ kind, model, baseUrl, batchSize, enabled });
}
