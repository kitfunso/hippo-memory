// The request-scope plumbing the composition roots (cli, server, stdio MCP) run their requests in. A busy code that
// escapes a scope leaves it as the port's StoreBusyError, as one from a store call does.
import {
  HOOK_DB_WAIT_MS,
  noteStoreBusy,
  outsideRequestStores,
  runWithRequestStores,
  scopedBusyWait,
  SERVER_DB_WAIT_MS,
} from '../../db/index.js';
import { withRequestStoresSync } from '../../db/request-stores.js';
import { isStoreBusy } from '../port.js';
import { inPortTerms, rethrowInPortTerms } from './port-errors.js';

type RequestPreset = 'cli' | 'hook' | 'server';

/** Lock wait per root; a hook also skips later writes once one wait runs out, so it never stalls its host. */
const PRESETS = {
  cli: {},
  hook: { busyWaitMs: HOOK_DB_WAIT_MS, failFastWhenBusy: true },
  server: { busyWaitMs: SERVER_DB_WAIT_MS },
} as const;

/** Runs `fn` with one store handle per store, closed with it, at the root's lock wait. */
export function runSqliteRequest<T>(fn: () => T | Promise<T>, preset: RequestPreset): Promise<T> {
  return runWithRequestStores(fn, PRESETS[preset]).catch(rethrowInPortTerms);
}

/** The hook preset: a store still busy after the wait skips the hook's work with one warning, undefined and exit 0. */
export async function runSqliteHookRequest<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await runSqliteRequest(fn, 'hook');
  } catch (error) {
    if (!isStoreBusy(error)) throw error;
    noteStoreBusy('hook skipped');
    return undefined;
  }
}

/** A synchronous batch, such as an import's writes, opens each store once; inside a request it joins that scope. */
export function runSqliteBatch<T>(fn: () => T): T {
  return inPortTerms(() => withRequestStoresSync(fn));
}

/** A scope of its own: the caller closes a handle the work holds across its pauses; the lock wait carries over. */
export function runDetachedSqliteRequest<T>(fn: () => T | Promise<T>): Promise<T> {
  const busyWaitMs = scopedBusyWait();
  return outsideRequestStores(() => runWithRequestStores(fn, { busyWaitMs })).catch(rethrowInPortTerms);
}
