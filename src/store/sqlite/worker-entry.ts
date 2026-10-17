// Entry of a store worker thread; executor.ts starts it and nothing imports it. The work is in worker-jobs.ts.
import { parentPort, workerData } from 'node:worker_threads';
import { serveJobs } from './worker-jobs.js';
import type { WorkerInit } from './worker-ops.js';
import { keepVectorGraphLoaded } from '../../db/vector-graph-search.js';

if (parentPort) {
  // Only serve starts store threads, and its nearest-vector reads run here, so the opt-in must live in the thread.
  keepVectorGraphLoaded();
  // SAFETY: executor.ts is the only code that starts this file, and it passes a WorkerInit.
  serveJobs(parentPort, workerData as WorkerInit);
}
