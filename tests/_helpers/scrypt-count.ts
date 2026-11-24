import { createHook } from 'node:async_hooks';

let runs = 0;

createHook({
  init(_id, type) {
    if (type === 'SCRYPTREQUEST') runs += 1;
  },
}).enable();

/** Pooled scrypt runs since this helper loaded. */
export const scryptRuns = (): number => runs;
