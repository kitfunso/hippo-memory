// The sessions the composition roots (cli, server, stdio MCP) run requests in; a busy code escaping
// a session's work surfaces as the port's StoreBusyError, as one from a store call does.
import {
  HOOK_DB_WAIT_MS,
  noteStoreBusy,
  RequestStores,
  SERVER_DB_WAIT_MS,
  withSharedStoreHandles,
  withSharedStoreHandlesSync,
} from '../../../db/index.js';
import type { StoreRuntime } from '../../../db/store-runtime.js';
import { isStoreBusy } from '../../../base/ports/store.js';
import { inPortTerms, rethrowInPortTerms } from './port-errors.js';

export type RequestPreset = 'cli' | 'hook' | 'server';

/** Lock wait per root; a hook also skips later writes once one wait runs out, so it never stalls
 * its host. */
const PRESETS = {
  cli: {},
  hook: { busyWaitMs: HOOK_DB_WAIT_MS, failFastWhenBusy: true },
  server: { busyWaitMs: SERVER_DB_WAIT_MS },
} as const;

/** One request's store handles at the root's lock wait; the caller closes it. */
export function openSqliteSession(preset: RequestPreset, runtime?: StoreRuntime): RequestStores {
  return new RequestStores({ ...PRESETS[preset], runtime });
}

type SessionWork<T> = (session: RequestStores) => T | Promise<T>;

/** Runs `fn` with a session of its own at the root's lock wait, closed when `fn` settles. */
export function runSqliteRequest<T>(
  fn: SessionWork<T>,
  preset: RequestPreset,
  runtime?: StoreRuntime,
): Promise<T> {
  return withSharedStoreHandles(fn, { ...PRESETS[preset], runtime }).catch(rethrowInPortTerms);
}

/** The hook preset: a store still busy after the wait skips the hook's work with one warning,
 * undefined and exit 0. */
export async function runSqliteHookRequest<T>(
  fn: SessionWork<T>,
  runtime?: StoreRuntime,
): Promise<T | undefined> {
  try {
    return await runSqliteRequest(fn, 'hook', runtime);
  } catch (error) {
    if (!isStoreBusy(error)) throw error;
    noteStoreBusy('hook skipped');
    return undefined;
  }
}

/** A synchronous batch, such as an import's writes, with a session of its own, so it opens each
 * store once. */
export function runSqliteBatch<T>(fn: (session: RequestStores) => T, runtime?: StoreRuntime): T {
  return inPortTerms(() => withSharedStoreHandlesSync(fn, { runtime }));
}
