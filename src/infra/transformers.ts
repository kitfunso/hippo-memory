import { resolveTransformersPackage } from '../base/embeddings/local.js';
import { MINUTE_MS } from '../base/util/time.js';
import { errorCode, errorMessage } from '../base/util/log.js';

/** The package's module namespace, typed by the parts the caller reads; null when neither
 * package is installed. */
export async function importTransformers<M>(): Promise<{
  readonly name: string;
  readonly mod: M;
} | null> {
  const pkg = resolveTransformersPackage();
  if (!pkg) return null;
  try {
    return { name: pkg.name, mod: await import(/* @vite-ignore */ pkg.url) };
  } catch (err) {
    const code = errorCode(err);
    throw new Error(
      `transformers import failed (${pkg.name}): ${code ? `${code} ` : ''}${errorMessage(err)}`,
      {
        cause: err,
      },
    );
  }
}

export interface ModelLoadPolicy {
  readonly timeoutMs: number;
  readonly backoffMs: number;
}

export const MODEL_LOAD_POLICY: ModelLoadPolicy = {
  timeoutMs: 2 * MINUTE_MS,
  backoffMs: 5 * MINUTE_MS,
};

export interface ModelLoads<T> {
  load(key: string, start: () => Promise<T>): Promise<T>;
}

function loadWithTimeout<T>(
  key: string,
  start: () => Promise<T>,
  timeoutMs: number,
  onLoaded: (model: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${key} did not load within ${timeoutMs / 1000} s`)),
      timeoutMs,
    );
    timer.unref();
    Promise.resolve()
      .then(start)
      .then(
        (model) => {
          clearTimeout(timer);
          onLoaded(model);
          resolve(model);
        },
        (err) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(errorMessage(err)));
        },
      );
  });
}

/**
 * One load per key at a time, bounded by the policy's timeout; `onFailure` hears each failed
 * attempt, so once per backoff window.
 */
export function createModelLoads<T>(
  policy: ModelLoadPolicy,
  onFailure?: (key: string, err: Error) => void,
): ModelLoads<T> {
  const loaded = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();
  const failed = new Map<string, { readonly error: Error; readonly until: number }>();

  const attempt = (key: string, start: () => Promise<T>): Promise<T> =>
    loadWithTimeout(key, start, policy.timeoutMs, (model) => {
      loaded.set(key, model);
      failed.delete(key);
    });

  return {
    load(key, start) {
      const model = loaded.get(key);
      if (model !== undefined) return Promise.resolve(model);
      const pending = inFlight.get(key);
      if (pending) return pending;
      const failure = failed.get(key);
      if (failure && Date.now() < failure.until) return Promise.reject(failure.error);
      const next = attempt(key, start)
        .catch((err: Error) => {
          failed.set(key, { error: err, until: Date.now() + policy.backoffMs });
          onFailure?.(key, err);
          throw err;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, next);
      return next;
    },
  };
}
