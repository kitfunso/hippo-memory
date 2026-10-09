// Entry of a store worker thread; executor.ts starts it and nothing imports it. The work is in worker-jobs.ts.
import { parentPort, workerData } from 'node:worker_threads';
import { serveJobs } from './worker-jobs.js';
import type { WorkerInit } from './worker-ops.js';

if (parentPort) {
  // SAFETY: executor.ts is the only code that starts this file, and it passes a WorkerInit.
  serveJobs(parentPort, workerData as WorkerInit);
}
