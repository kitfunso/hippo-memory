// The local embedder's model rules, and whether its optional package is installed, found by resolving the package's
// path: nothing here imports the package or loads a model, which src/infra/local-embedder.ts does.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { EmbeddingsConfig } from '../config/config.js';
import { ignoringCodes } from '../util/expected-errors.js';
import { errorFields, errorMessage, log } from '../util/log.js';

export const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

const _require = createRequire(import.meta.url);

// Importing both loads two onnxruntime-node builds whose finalizers can double-free on exit, so one is picked: the
// maintained package hippo ships, with Xenova only as a fallback a user installed.
const TRANSFORMERS_PACKAGES = ['@huggingface/transformers', '@xenova/transformers'] as const;

export interface TransformersPackage {
  readonly name: string;
  /** The ESM entry: a require-style import loads the CommonJS build, a second copy with its own ONNX sessions. */
  readonly url: string;
}

/** The installed package to import, or null when neither is installed. */
export function resolveTransformersPackage(): TransformersPackage | null {
  for (const name of TRANSFORMERS_PACKAGES) {
    const url = entryUrl(name);
    if (url) return { name, url };
  }
  return null;
}

// Neither resolver finding the package means it is not installed, and the caller tries the next one.
const NOT_INSTALLED = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'];

function entryUrl(name: string): string | null {
  // import.meta.resolve is missing under some module runners (vitest's included), so the require-based resolve stands
  // in there.
  const viaImport =
    'resolve' in import.meta ? ignoringCodes(NOT_INSTALLED, () => import.meta.resolve(name)) : undefined;
  if (viaImport !== undefined) return viaImport;
  const viaRequire = ignoringCodes(NOT_INSTALLED, () => _require.resolve(name));
  return viaRequire === undefined ? null : pathToFileURL(viaRequire).href;
}

let installed: boolean | undefined;

/** Check (synchronously) if @xenova/transformers or @huggingface/transformers is installed. */
export function isEmbeddingAvailable(): boolean {
  return (installed ??= resolveTransformersPackage() !== null);
}

export function resolveEmbeddingModel(embeddings: EmbeddingsConfig, explicitModel?: string): string {
  const direct = explicitModel?.trim();
  if (direct) return direct;

  try {
    const configured = embeddings.model?.trim();
    if (configured) return configured;
  } catch (err) {
    log.warn(`embedding model config unreadable, using the default model: ${errorMessage(err)}`, errorFields(err));
  }

  return DEFAULT_EMBEDDING_MODEL;
}
