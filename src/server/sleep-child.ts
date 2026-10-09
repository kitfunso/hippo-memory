// Entry of the process that runs one POST /v1/sleep; sleep-offload.ts starts it and nothing imports it.
// The sleep module alone: the api barrel loads far more than one sleep needs, and every sleep pays for the start.
import { sleep } from '../api/sleep.js';
import { isStoreBusy, runWithRequestStores, SERVER_DB_WAIT_MS } from '../db/index.js';
import { errorMessage } from '../util/log.js';
import type { SleepJob, SleepReply } from './sleep-offload.js';

function failed<E>(err: E): SleepReply {
  return { ok: false, busy: isStoreBusy(err), message: errorMessage(err), stack: err instanceof Error ? err.stack : undefined };
}

process.once('message', (message) => {
  // SAFETY: sleep-offload.ts is the only writer on this channel and sends exactly one SleepJob.
  const job = message as SleepJob;
  const ctx = { hippoRoot: job.hippoRoot, tenantId: job.tenantId, actor: job.actor };
  // The server's own request scope and lock wait, so a busy store answers as it did when sleep ran in the server.
  runWithRequestStores(() => sleep(ctx, job.opts), { busyWaitMs: SERVER_DB_WAIT_MS })
    .then((result): SleepReply => ({ ok: true, result }), failed)
    // Exit only once the reply is written, or the parent could see the process end first.
    .then((reply) => process.send?.(reply, () => process.exit(0)));
});
