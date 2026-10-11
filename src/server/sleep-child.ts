// Entry of the process that runs one POST /v1/sleep; sleep-offload.ts starts it and nothing imports it.
// The sleep module alone: the api barrel loads far more than one sleep needs, and every sleep pays for the start.
import { sleep } from '../api/sleep.js';
import { isStoreBusy, runWithRequestStores, SERVER_DB_WAIT_MS } from '../db/index.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { SleepJob, SleepReply } from './sleep-offload.js';

function failed<E>(err: E): SleepReply {
  return { ok: false, busy: isStoreBusy(err), message: errorMessage(err), stack: err instanceof Error ? err.stack : undefined };
}

/** Resolves to the exit code once the channel has taken the reply, or failed to. */
function sendReply(reply: SleepReply): Promise<number> {
  return new Promise((resolve) => {
    process.send?.(reply, (sendErr: Error | null) => {
      if (sendErr) log.error(`sleep child: sending the reply failed: ${errorMessage(sendErr)}`, errorFields(sendErr));
      resolve(sendErr ? 1 : 0);
    });
  });
}

process.once('message', (message) => {
  // SAFETY: sleep-offload.ts is the only writer on this channel and sends exactly one SleepJob.
  const job = message as SleepJob;
  const ctx = { hippoRoot: job.hippoRoot, tenantId: job.tenantId, actor: job.actor };
  // The server's own request scope and lock wait, so a busy store answers as it did when sleep ran in the server.
  runWithRequestStores(() => sleep(ctx, job.opts), { busyWaitMs: SERVER_DB_WAIT_MS })
    .then((result): SleepReply => ({ ok: true, result }), failed)
    // Exit only once the reply is written, or the parent could see the process end first.
    .then(sendReply)
    .catch((err) => {
      log.error(`sleep child: the reply could not be sent: ${errorMessage(err)}`, errorFields(err));
      return 1;
    })
    .then((code) => process.exit(code));
});
