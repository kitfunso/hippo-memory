// The local Transformers.js embedder, a leaf so provider.ts can wrap it without importing index.ts.
import { envModelCache } from '../../util/env.js';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { loadConfig } from '../../core/config.js';
import { errorMessage, log } from '../../util/log.js';

const _require = createRequire(import.meta.url);

let _embeddingAvailable: boolean | null = null;

// A pipeline is expensive to load, so one instance per model is kept for the process.
const _pipelineInstances = new Map<string, EmbeddingPipeline>();
const _pipelineLoading = new Map<string, Promise<EmbeddingPipeline | null>>();
const _pipelineErrors = new Map<string, string>();

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

/** Check (synchronously) if @xenova/transformers or @huggingface/transformers is installed. */
export function isEmbeddingAvailable(): boolean {
  if (_embeddingAvailable !== null) return _embeddingAvailable;

  try {
    _require.resolve('@xenova/transformers');
    _embeddingAvailable = true;
    return true;
  } catch {
    // fall through
  }

  try {
    _require.resolve('@huggingface/transformers');
    _embeddingAvailable = true;
    return true;
  } catch {
    // fall through
  }

  _embeddingAvailable = false;
  return false;
}

// Importing both packages loads two incompatible onnxruntime-node builds whose finalizers can double-free on exit,
// so pick one first: the maintained package hippo ships, with Xenova only as a fallback a user installed.
function resolveTransformersPackage(): string | null {
  try {
    _require.resolve('@huggingface/transformers');
    return '@huggingface/transformers';
  } catch {
    // fall through
  }
  try {
    _require.resolve('@xenova/transformers');
    return '@xenova/transformers';
  } catch {
    return null; // neither optional package is installed; callers fall back to no local embeddings
  }
}

async function loadPipeline(model: string): Promise<EmbeddingPipeline | null> {
  const loaded = _pipelineInstances.get(model);
  if (loaded) return loaded;
  const inFlight = _pipelineLoading.get(model);
  if (inFlight) return inFlight;

  const loading = createPipeline(model);

  _pipelineLoading.set(model, loading);
  return loading;
}

/** The model's pipeline, or null with the reason recorded in `_pipelineErrors`. */
async function createPipeline(model: string): Promise<EmbeddingPipeline | null> {
  const pkg = resolveTransformersPackage();
  if (!pkg) {
    _pipelineErrors.set(model, 'no transformers package is installed');
    return null;
  }

  const pipelineFn = await importPipelineFactory(pkg, model);
  if (!pipelineFn) return null;

  // The offline bundle used in egress-blocked sandboxes ships only the FP32 model, so use whichever file is on disk.
  const cacheRoot = envModelCache();
  const quantized = !cacheRoot
    || fs.existsSync(path.join(cacheRoot, model, 'onnx', 'model_quantized.onnx'));

  try {
    const instance = await pipelineFn('feature-extraction', model, { quantized });
    _pipelineInstances.set(model, instance);
    return instance;
  } catch (err) {
    const reason = `embedding pipeline load failed (${model}): ${String(err)}`;
    log.debug(reason);
    _pipelineErrors.set(model, reason);
    return null;
  } finally {
    _pipelineLoading.delete(model);
  }
}

/** The package's `pipeline` function, or null with the reason recorded in `_pipelineErrors`. */
async function importPipelineFactory(pkg: string, model: string): Promise<PipelineFactory | null> {
  let pipelineFn: PipelineFactory | null = null;
  try {
    // The package is an optional peer, so the dynamic import is typed by what this file reads; a missing export falls to the null below.
    const mod: TransformersModule = await import(/* @vite-ignore */ pkg);
    const cache = envModelCache();
    if (cache && mod.env) {
      mod.env.cacheDir = cache;
      mod.env.localModelPath = cache;
      mod.env.allowRemoteModels = false;
    }
    pipelineFn = mod.pipeline ?? mod.default?.pipeline ?? null;
  } catch (err) {
    // String(err) keeps a Node error's [ERR_...] code, which callers match on.
    const reason = `transformers import failed (${pkg}): ${String(err)}`;
    log.debug(reason);
    _pipelineErrors.set(model, reason);
    return null;
  }

  if (!pipelineFn) {
    _pipelineErrors.set(model, `${pkg} exports no pipeline function`);
    return null;
  }
  return pipelineFn;
}

/** Throws, with the reason, when the model's pipeline cannot load: a provider-level failure, not a per-item skip. */
export async function requireLocalPipeline(model: string): Promise<void> {
  if (await loadPipeline(model)) return;
  throw new Error(`local embedding model did not load: ${_pipelineErrors.get(model) ?? 'unknown reason'}`);
}

export function resolveEmbeddingModel(hippoRoot: string, explicitModel?: string): string {
  const direct = explicitModel?.trim();
  if (direct) return direct;

  try {
    const configured = loadConfig(hippoRoot).embeddings.model?.trim();
    if (configured) return configured;
  } catch {
    // Fall back to the default model when config cannot be read.
  }

  return DEFAULT_EMBEDDING_MODEL;
}

/** Embeds `text` with the local model, or returns `[]` when Transformers.js is missing or fails; `role` adds e5-style prefixes. */
export async function getEmbedding(
  text: string,
  model = DEFAULT_EMBEDDING_MODEL,
  role?: EmbeddingRole,
): Promise<number[]> {
  if (!isEmbeddingAvailable()) return [];

  try {
    const pipe = await loadPipeline(model);
    if (!pipe) return [];

    const prefix = prefixFor(model, role);
    const input = prefix ? `${prefix}${text}` : text;
    const output = await pipe(input, { pooling: poolingFor(model), normalize: true });
    return Array.from(output.data);
  } catch (err) {
    // The caller sees `[]` and names the memory; the reason only shows at debug.
    log.debug(`local embedding failed: ${errorMessage(err)}`);
    return [];
  }
}
