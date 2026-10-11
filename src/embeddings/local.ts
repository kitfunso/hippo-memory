// The local Transformers.js embedder, a leaf so provider.ts can wrap it without importing index.ts.
import { envModelCache } from '../util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../core/config.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import { createModelLoads, importTransformers, MODEL_LOAD_POLICY, resolveTransformersPackage } from './transformers.js';

/** Opens once a model's load starts downloading weights; only then does a recall stop waiting at its deadline. */
interface FetchGate {
  readonly opened: Promise<void>;
  readonly open: () => void;
}

/** The one call this file makes on a Transformers.js feature-extraction pipeline, and the part of its tensor it reads. */
interface EmbeddingPipeline {
  (input: string, options: { pooling: 'cls' | 'mean'; normalize: boolean }): Promise<{ data: ArrayLike<number> }>;
}

type PipelineFactory = (task: 'feature-extraction', model: string, options: { quantized: boolean }) => Promise<EmbeddingPipeline>;

/** The settings written on the package's `env` object. */
interface TransformersEnv {
  cacheDir?: string;
  localModelPath?: string;
  allowRemoteModels?: boolean;
}

/** The parts of the optional package's module this file reads; either export spelling may carry `pipeline`. */
interface TransformersModule {
  env?: TransformersEnv;
  pipeline?: PipelineFactory;
  default?: { pipeline?: PipelineFactory };
}

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/** BGE was trained with CLS pooling; everything else gets mean, the sentence-transformers default, since CLS degrades mean-trained models. */
export function poolingFor(model: string): 'cls' | 'mean' {
  return /\bbge\b/i.test(model) ? 'cls' : 'mean';
}

/** `query` is search input, `passage` is a document being indexed; no role means no prefix on any model. */
export type EmbeddingRole = 'query' | 'passage';

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
  /** Whether a package is installed, answered without importing it. */
  installed(): boolean;
  /** The package's module, or null when neither package is installed. */
  load(): Promise<{ readonly name: string; readonly mod: TransformersModule } | null>;
}

const INSTALLED_TRANSFORMERS: LocalTransformers = {
  installed: () => resolveTransformersPackage() !== null,
  load: () => importTransformers<TransformersModule>(),
};

export interface LocalEmbedder {
  isAvailable(): boolean;
  /** Throws, with the reason, when the model's pipeline cannot load: a provider-level failure, not a per-item skip.
   * `signal` ends the wait, never the load, and only once the load is downloading: a load from disk ends soon on its own, a download may not. */
  requirePipeline(model: string, signal?: AbortSignal): Promise<void>;
  /** `text`'s vector, or `[]` when the model is missing or fails; `role` adds e5-style prefixes. */
  embed(text: string, model: string, role?: EmbeddingRole): Promise<number[]>;
}

/** One pipeline per model for the embedder's life, since a pipeline is expensive to load. */
export function createLocalEmbedder(transformers: LocalTransformers = INSTALLED_TRANSFORMERS): LocalEmbedder {
  let available: boolean | null = null;
  const gates = new Map<string, FetchGate>();
  const pipelines = createModelLoads<EmbeddingPipeline>(MODEL_LOAD_POLICY, warnLoadFailure);
  const load = (model: string): Promise<EmbeddingPipeline> => pipelines.load(model, () => createPipeline(transformers, model, gates));
  const isAvailable = (): boolean => (available ??= transformers.installed());
  return {
    isAvailable,
    requirePipeline: (model, signal) => waitForPipeline(load(model), signal && gateOf(gates, model).opened, signal),
    async embed(text, model, role) {
      if (!isAvailable()) return [];
      try {
        const pipe = await load(model);
        const prefix = prefixFor(model, role);
        const output = await pipe(prefix ? `${prefix}${text}` : text, { pooling: poolingFor(model), normalize: true });
        return Array.from(output.data);
      } catch (err) {
        // The caller sees `[]` and names the memory; a failed load already warned once for its backoff window.
        log.debug(`local embedding failed: ${errorMessage(err)}`);
        return [];
      }
    },
  };
}

function warnLoadFailure(model: string, err: Error): void {
  const retry = `the next try is in ${MODEL_LOAD_POLICY.backoffMs / 60_000} minutes`;
  log.warn(`local embedding model ${model} did not load (${errorMessage(err)}); embeddings stay off and ${retry}`, errorFields(err));
}

/** The model's pipeline; throws the reason it cannot load. */
async function createPipeline(transformers: LocalTransformers, model: string, gates: Map<string, FetchGate>): Promise<EmbeddingPipeline> {
  // The package is an optional peer, so the dynamic import is typed by what this file reads; a missing export throws below.
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

  // The offline bundle used in egress-blocked sandboxes ships only the FP32 model, so use whichever file is on disk.
  const quantized = !cache || fs.existsSync(path.join(cache, model, 'onnx', 'model_quantized.onnx'));
  if (fetchesWeights(mod.env, model)) gateOf(gates, model).open();
  try {
    return await pipelineFn('feature-extraction', model, { quantized });
  } finally {
    gates.delete(model);
  }
}

/** Whether the load will download: remote models are allowed and no folder the package reads holds the model's ONNX files. */
function fetchesWeights(env: TransformersEnv | undefined, model: string): boolean {
  if (env?.allowRemoteModels === false) return false;
  return ![env?.localModelPath, env?.cacheDir].some((dir) => dir !== undefined && fs.existsSync(path.join(dir, model, 'onnx')));
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

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function waitForPipeline(loading: Promise<EmbeddingPipeline>, downloading?: Promise<void>, signal?: AbortSignal): Promise<void> {
  try {
    await (downloading && signal ? Promise.race([loading, downloading.then(() => rejectOnAbort(signal))]) : loading);
  } catch (err) {
    // The download goes on, and the first call after it lands gets the model.
    if (signal?.aborted && err === signal.reason) throw err;
    throw new Error(`local embedding model did not load: ${errorMessage(err)}`, { cause: err });
  }
}

/** The process's embedder, shared by every provider and caller so each model loads once. */
export const sharedLocalEmbedder = createLocalEmbedder();

/** Check (synchronously) if @xenova/transformers or @huggingface/transformers is installed. */
export function isEmbeddingAvailable(): boolean {
  return sharedLocalEmbedder.isAvailable();
}

export function resolveEmbeddingModel(hippoRoot: string, explicitModel?: string): string {
  const direct = explicitModel?.trim();
  if (direct) return direct;

  try {
    const configured = loadConfig(hippoRoot).embeddings.model?.trim();
    if (configured) return configured;
  } catch (err) {
    log.warn(`embedding model config unreadable, using the default model: ${errorMessage(err)}`);
  }

  return DEFAULT_EMBEDDING_MODEL;
}

/** Embeds `text` with the local model, or returns `[]` when Transformers.js is missing or fails; `role` adds e5-style prefixes. */
export function getEmbedding(text: string, model = DEFAULT_EMBEDDING_MODEL, role?: EmbeddingRole): Promise<number[]> {
  return sharedLocalEmbedder.embed(text, model, role);
}
