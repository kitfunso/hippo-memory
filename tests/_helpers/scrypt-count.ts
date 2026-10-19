// Counts scrypt jobs handed to the thread pool, from Node's own async-resource record. A key check derives there;
// scryptSync makes no job, so minting a key adds nothing.
import { createHook } from 'node:async_hooks';

let runs = 0;

createHook({
  init(_id, type) {
    if (type === 'SCRYPTREQUEST') runs += 1;
  },
}).enable();

/** Pooled scrypt runs since this helper loaded. */
export const scryptRuns = (): number => runs;
