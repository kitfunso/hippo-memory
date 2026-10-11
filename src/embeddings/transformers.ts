// The optional Transformers.js package, and a bounded load of a model from it, shared by the local embedder and the cross-encoder.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { errorCode, errorMessage } from '../util/log.js';

const _require = createRequire(import.meta.url);

// Importing both loads two onnxruntime-node builds whose finalizers can double-free on exit, so one is picked:
// the maintained package hippo ships, with Xenova only as a fallback a user installed.
const TRANSFORMERS_PACKAGES = ['@huggingface/transformers', '@xenova/transformers'] as const;

export interface TransformersPackage {
  readonly name: string;
  /** The ESM entry; a require-style import picks the CommonJS build and puts a second copy of the library, with its own ONNX sessions, in the process. */
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

function entryUrl(name: string): string | null {
  try {
    return import.meta.resolve(name);
  } catch {
    // import.meta.resolve is missing under some module runners (vitest's included), so the require-based resolve stands in there.
    try {
      return pathToFileURL(_require.resolve(name)).href;
    } catch {
      return null; // not installed; the caller tries the next package
    }
  }
}

/** The package's module namespace, typed by the parts the caller reads; null when neither package is installed. */
export async function importTransformers<M>(): Promise<{ readonly name: string; readonly mod: M } | null> {
  const pkg = resolveTransformersPackage();
  if (!pkg) return null;
  try {
    return { name: pkg.name, mod: await import(/* @vite-ignore */ pkg.url) };
  } catch (err) {
    // A Node error's code (ERR_MODULE_NOT_FOUND and the like) says more than its message alone.
    const code = errorCode(err);
    throw new Error(`transformers import failed (${pkg.name}): ${code ? `${code} ` : ''}${errorMessage(err)}`, { cause: err });
  }
}

export interface ModelLoadPolicy {
  /** How long one load may run before it counts as failed; nothing can cancel it, so it keeps running and a late model is still kept. */
  readonly timeoutMs: number;
  /** How long a failure is answered from memory before the next call loads again. */
  readonly backoffMs: number;
}

// A quantized MiniLM is about 23 MB, so two minutes is a 1.5 Mbit/s link; a load from disk takes about a second.
// The backoff matches the reranker outage warning's repeat window, so each window has one attempt and one warning.
export const MODEL_LOAD_POLICY: ModelLoadPolicy = { timeoutMs: 2 * 60_000, backoffMs: 5 * 60_000 };

export interface ModelLoads<T> {
  /** The model under `key`: the loaded one, the load in flight, the failure inside its backoff window, or a new `start()`. */
  load(key: string, start: () => Promise<T>): Promise<T>;
}

/** One load per key at a time, bounded by the policy's timeout; `onFailure` hears each failed attempt, so once per backoff window. */
export function createModelLoads<T>(policy: ModelLoadPolicy, onFailure?: (key: string, err: Error) => void): ModelLoads<T> {
  const loaded = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();
  const failed = new Map<string, { readonly error: Error; readonly until: number }>();

  const attempt = (key: string, start: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${key} did not load within ${policy.timeoutMs / 1000} s`)), policy.timeoutMs);
    timer.unref();
    Promise.resolve().then(start).then((model) => {
      clearTimeout(timer);
      loaded.set(key, model);
      failed.delete(key);
      resolve(model);
    }, (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(errorMessage(err)));
    });
  });

  return {
    load(key, start) {
      const model = loaded.get(key);
      if (model !== undefined) return Promise.resolve(model);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const failure = failed.get(key);
      if (failure && Date.now() < failure.until) return Promise.reject(failure.error);
      const next = attempt(key, start).catch((err: Error) => {
        failed.set(key, { error: err, until: Date.now() + policy.backoffMs });
        onFailure?.(key, err);
        throw err;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, next);
      return next;
    },
  };
}
