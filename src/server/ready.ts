import { SERVER_DB_WAIT_MS, runWithRequestStores } from '../db/index.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { HippoStore } from '../store/index.js';

// A prober must never see a 429, so the store read is bounded by remembering its answer instead of rate-limiting the route.
const READY_WINDOW_MS = 1000;

export type ReadyProbe = () => Promise<boolean>;

/** True when the store answered; one read per window whatever the caller count, and a failed read is remembered for the same window. */
function createReadyProbe(readiness: { ping(): Promise<void> }, now: () => number = Date.now): ReadyProbe {
  let answer: { at: number; ok: boolean } | undefined;
  let inFlight: Promise<boolean> | undefined;

  async function read(): Promise<boolean> {
    let ok = true;
    try {
      await runWithRequestStores(() => readiness.ping(), { busyWaitMs: SERVER_DB_WAIT_MS });
    } catch (err) {
      log.warn(`GET /ready: the store did not answer: ${errorMessage(err)}`, errorFields(err));
      ok = false;
    }
    answer = { at: now(), ok };
    return ok;
  }

  return () => {
    if (answer !== undefined && now() - answer.at < READY_WINDOW_MS) return Promise.resolve(answer.ok);
    inFlight ??= read().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

const probes = new WeakMap<HippoStore, ReadyProbe>();

/** The shared probe for a served store, so every request to that server draws on one remembered answer. */
export function readyProbeFor(store: HippoStore, readiness: { ping(): Promise<void> }, now: () => number = Date.now): ReadyProbe {
  let probe = probes.get(store);
  if (probe === undefined) {
    probe = createReadyProbe(readiness, now);
    probes.set(store, probe);
  }
  return probe;
}
