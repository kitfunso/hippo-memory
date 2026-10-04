// The local Transformers.js embedder, a leaf so embedding-provider.ts can wrap it without importing embeddings.ts.
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { loadConfig } from './config.js';
import { log } from './log.js';

const _require = createRequire(import.meta.url);

let _embeddingAvailable: boolean | null = null;

// A pipeline is expensive to load, so one instance per model is kept for the process.
const _pipelineInstances = new Map<string, unknown>();
const _pipelineLoading = new Map<string, Promise<unknown>>();

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

// Use Function constructor to bypass TypeScript static module resolution
// for optional peer dependencies that may not be installed.
// SAFETY: `import(s)` always resolves to a module namespace object (or rejects);
// Promise<object> names that honestly without claiming a specific module shape.
const _dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<object>;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadPipeline(model: string): Promise<any> {
  if (_pipelineInstances.has(model)) return _pipelineInstances.get(model);
  if (_pipelineLoading.has(model)) return _pipelineLoading.get(model);

  const loading = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = resolveTransformersPackage();
    if (!pkg) return null;

    let pipelineFn: any = null;
    try {
      // SAFETY: the resolved module's shape is untyped by design (optional peer
      // dependency); pipelineFn/mod.env are read defensively below and any
      // failure to find a usable pipeline falls through to `return null`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = await _dynImport(pkg) as any;
      if (process.env.HIPPO_MODEL_CACHE) {
        if (mod.env) {
          mod.env.cacheDir = process.env.HIPPO_MODEL_CACHE;
          mod.env.localModelPath = process.env.HIPPO_MODEL_CACHE;
          mod.env.allowRemoteModels = false;
        }
      }
      pipelineFn = mod.pipeline ?? mod.default?.pipeline;
    } catch (err) {
      log.debug(`transformers import failed (${pkg}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (!pipelineFn) return null;

    // The offline bundle used in egress-blocked sandboxes ships only the FP32 model, so use whichever file is on disk.
    const cacheRoot = process.env.HIPPO_MODEL_CACHE?.trim();
    const quantized = !cacheRoot
      || fs.existsSync(path.join(cacheRoot, model, 'onnx', 'model_quantized.onnx'));

    try {
      const instance = await pipelineFn('feature-extraction', model, { quantized });
      _pipelineInstances.set(model, instance);
      return instance;
    } catch (err) {
      log.debug(`embedding pipeline load failed (${model}): ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      _pipelineLoading.delete(model);
    }
  })();

  _pipelineLoading.set(model, loading);
  return loading;
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
    // SAFETY: pipe() is a Transformers.js feature-extraction pipeline call;
    // its untyped output is read defensively below (only `.data`, cast on
    // the return line to the documented Float32Array tensor shape).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const output = await pipe(input, { pooling: poolingFor(model), normalize: true }) as any;
    // SAFETY: output.data is a Float32Array per the feature-extraction
    // pipeline's documented tensor output shape.
    return Array.from(output.data as Float32Array);
  } catch (err) {
    // The caller sees `[]` and names the memory; the reason only shows at debug.
    log.debug(`local embedding failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
