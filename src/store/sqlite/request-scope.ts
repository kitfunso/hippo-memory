// The request-scope plumbing the composition roots (cli, server, stdio MCP) run their requests in.
import {
  HOOK_DB_WAIT_MS,
  outsideRequestStores,
  runWithRequestStores,
  scopedBusyWait,
  SERVER_DB_WAIT_MS,
} from '../../db/index.js';

export type RequestPreset = 'cli' | 'hook' | 'server';

/** Lock wait per root; a hook also skips later writes once one wait runs out, so it never stalls its host. */
const PRESETS = {
  cli: {},
  hook: { busyWaitMs: HOOK_DB_WAIT_MS, failFastWhenBusy: true },
  server: { busyWaitMs: SERVER_DB_WAIT_MS },
} as const;

/** Runs `fn` with one store handle per store, closed with it, at the root's lock wait. */
export function runSqliteRequest<T>(fn: () => T | Promise<T>, preset: RequestPreset): Promise<T> {
  return runWithRequestStores(fn, PRESETS[preset]);
}

/** A scope of its own: the caller closes a handle the work holds across its pauses; the lock wait carries over. */
export function runDetachedSqliteRequest<T>(fn: () => T | Promise<T>): Promise<T> {
  const busyWaitMs = scopedBusyWait();
  return outsideRequestStores(() => runWithRequestStores(fn, { busyWaitMs }));
}
