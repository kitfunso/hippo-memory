import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_EMBEDDING_MODEL, resolveTransformersPackage } from '../base/embeddings/local.js';
import type { EmbeddingRole } from '../base/ports/embedder.js';
import { envModelCache } from '../base/util/env.js';
import { errorFields, errorMessage, log } from '../base/util/log.js';
import { MINUTE_MS } from '../base/util/time.js';
import { createModelLoads, importTransformers, MODEL_LOAD_POLICY } from './transformers.js';

interface FetchGate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

interface EmbeddingPipeline {
  (
    input: string,
    options: { pooling: 'cls' | 'mean'; normalize: boolean },
  ): Promise<{ data: ArrayLike<number> }>;
}

type PipelineFactory = (
  task: 'feature-extraction',
  model: string,
  options: { quantized: boolean },
) => Promise<EmbeddingPipeline>;

interface TransformersEnv {
  cacheDir?: string;
  localModelPath?: string;
  allowRemoteModels?: boolean;
}

interface TransformersModule {
  env?: TransformersEnv;
  pipeline?: PipelineFactory;
  default?: { pipeline?: PipelineFactory };
}

/** BGE was trained with CLS pooling; everything else gets mean, the sentence-transformers
 * default, since CLS degrades mean-trained models. */
export function poolingFor(model: string): 'cls' | 'mean' {
  return /\bbge\b/i.test(model) ? 'cls' : 'mean';
}

/** e5 models only match a query to a passage when each side carries its trained prefix. */
export function prefixFor(model: string, role?: EmbeddingRole): string {
  if (!role) return '';
  if (/\be5\b/i.test(model)) {
    return role === 'query' ? 'query: ' : 'passage: ';
  }
  return '';
}

/** The optional package as the local embedder reaches it; tests hand in a stand-in. */
export interface LocalTransformers {
  installed(): boolean;
  load(): Promise<{ readonly name: string; readonly mod: TransformersModule } | null>;
}

const INSTALLED_TRANSFORMERS: LocalTransformers = {
  installed: () => resolveTransformersPackage() !== null,
  load: () => importTransformers<TransformersModule>(),
};

const INSTALL_RECHECK_MS = MODEL_LOAD_POLICY.backoffMs;

type Availability = { readonly kind: 'yes' } | { readonly kind: 'no'; readonly retryAt: number };

export interface LocalEmbedder {
  isAvailable(): boolean;
  requirePipeline(model: string, signal?: AbortSignal): Promise<void>;
  embed(text: string, model: string, role?: EmbeddingRole): Promise<number[]>;
}

/** One pipeline per model for the embedder's life, since a pipeline is expensive to load. */
export function createLocalEmbedder(
  transformers: LocalTransformers = INSTALLED_TRANSFORMERS,
): LocalEmbedder {
  let state: Availability = { kind: 'no', retryAt: 0 };
  const gates = new Map<string, FetchGate>();
  const pipelines = createModelLoads<EmbeddingPipeline>(MODEL_LOAD_POLICY, warnLoadFailure);
  const load = (model: string): Promise<EmbeddingPipeline> =>
    pipelines.load(model, () => createPipeline(transformers, model, gates));
  const isAvailable = (): boolean => {
    if (state.kind === 'yes') return true;
    const now = Date.now();
    if (now < state.retryAt) return false;
    state = transformers.installed()
      ? { kind: 'yes' }
      : { kind: 'no', retryAt: now + INSTALL_RECHECK_MS };
    return state.kind === 'yes';
  };
  return {
    isAvailable,
    requirePipeline: (model, signal) =>
      waitForPipeline(load(model), signal && gateOf(gates, model).opened, signal),
    async embed(text, model, role) {
      if (!isAvailable()) return [];
      try {
        const pipe = await load(model);
        const prefix = prefixFor(model, role);
        const output = await pipe(prefix ? `${prefix}${text}` : text, {
          pooling: poolingFor(model),
          normalize: true,
        });
        return Array.from(output.data);
      } catch (err) {
        log.warnThenSample(
          `local-embed:${model}`,
          `local embedding with ${model} failed: ${errorMessage(err)}`,
          errorFields(err),
        );
        return [];
      }
    },
  };
}

function warnLoadFailure(model: string, err: Error): void {
  const retry = `the next try is in ${MODEL_LOAD_POLICY.backoffMs / MINUTE_MS} minutes`;
  log.warn(
    `local embedding model ${model} did not load (${errorMessage(err)}); embeddings stay off and ${retry}`,
    errorFields(err),
  );
}

async function createPipeline(
  transformers: LocalTransformers,
  model: string,
  gates: Map<string, FetchGate>,
): Promise<EmbeddingPipeline> {
  const imported = await transformers.load();
  if (!imported) throw new Error('no transformers package is installed');
  const { name, mod } = imported;
  const cache = envModelCache();
  if (cache && mod.env) {
    mod.env.cacheDir = cache;
    mod.env.localModelPath = cache;
    mod.env.allowRemoteModels = false;
  }
  const pipelineFn = mod.pipeline ?? mod.default?.pipeline;
  if (!pipelineFn) throw new Error(`${name} exports no pipeline function`);

  const quantized =
    !cache || fs.existsSync(path.join(cache, model, 'onnx', 'model_quantized.onnx'));
  if (fetchesWeights(mod.env, model)) gateOf(gates, model).open();
  try {
    return await pipelineFn('feature-extraction', model, { quantized });
  } finally {
    gates.delete(model);
  }
}

function fetchesWeights(env: TransformersEnv | undefined, model: string): boolean {
  if (env?.allowRemoteModels === false) return false;
  return ![env?.localModelPath, env?.cacheDir].some(
    (dir) => dir !== undefined && fs.existsSync(path.join(dir, model, 'onnx')),
  );
}

function gateOf(gates: Map<string, FetchGate>, model: string): FetchGate {
  let gate = gates.get(model);
  if (!gate) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    gate = { opened, open };
    gates.set(model, gate);
  }
  return gate;
}

function rejectOnAbort(signal: AbortSignal, done: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true, signal: done });
    }
  });
}

async function waitForPipeline(
  loading: Promise<EmbeddingPipeline>,
  downloading?: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const left = new AbortController();
  try {
    await (downloading && signal
      ? Promise.race([loading, downloading.then(() => rejectOnAbort(signal, left.signal))])
      : loading);
  } catch (err) {
    if (signal?.aborted && err === signal.reason) throw err;
    throw new Error(`local embedding model did not load: ${errorMessage(err)}`, { cause: err });
  } finally {
    left.abort();
  }
}

/** The process's embedder, shared by every provider and caller so each model loads once. */
export const sharedLocalEmbedder = createLocalEmbedder();

/** Embeds `text` with the local model, or returns `[]` when Transformers.js is missing or fails;
 * `role` adds e5-style prefixes. */
export function getEmbedding(
  text: string,
  model = DEFAULT_EMBEDDING_MODEL,
  role?: EmbeddingRole,
): Promise<number[]> {
  return sharedLocalEmbedder.embed(text, model, role);
}
