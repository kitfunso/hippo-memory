// Entry of the dashboard's reader thread; dashboard-reader.ts starts it and nothing imports it. The
// work is in dashboard-reader-serve.ts.
import { parentPort, workerData } from 'node:worker_threads';
import type { ReaderThreadData } from './dashboard-reader.js';
import { serveReads } from './dashboard-reader-serve.js';

if (parentPort) {
  // SAFETY: dashboard-reader.ts is the only code that starts this file, and it passes a ReaderThreadData.
  serveReads(parentPort, workerData as ReaderThreadData);
}
