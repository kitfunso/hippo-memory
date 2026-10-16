// Entry of the process that runs one POST /v1/sleep or MCP auto-sleep; sleep-offload.ts starts it and nothing imports
// it. The sleep modules alone: the api barrel loads far more than one sleep needs, and every sleep pays for the start.
import { sleep } from '../api/sleep/sleep.js';
import { runConsolidation } from '../consolidate/sleep.js';
import { isStoreBusy } from '../api/busy.js';
import { runSqliteRequest } from '../store/sqlite/request-scope.js';
import { sqliteStore, sqliteSyncStore } from '../store/sqlite/store.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { SleepJob, SleepReply } from './sleep-offload.js';
import type { SleepResult } from '../api/sleep/sleep.js';
import type { ConsolidationResult } from '../consolidate/run.js';

type JobResult = SleepResult | ConsolidationResult;

function failed<E>(err: E): SleepReply<never> {
  return {
    ok: false,
    busy: isStoreBusy(err),
    message: errorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

/** Resolves to the exit code once the channel has taken the reply, or failed to. */
function sendReply(reply: SleepReply<JobResult>): Promise<number> {
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
  const work = (): Promise<JobResult> =>
    job.kind === 'consolidate'
      ? runConsolidation(sqliteSyncStore(job.hippoRoot).localFiles)
      : sleep(
          { hippoRoot: job.hippoRoot, tenantId: job.tenantId, actor: job.actor, store: sqliteStore(job.hippoRoot) },
          job.opts,
        );
  // The server's own request scope and lock wait, so a busy store answers as it did when sleep ran in the server.
  runSqliteRequest(work, 'server')
    .then((result): SleepReply<JobResult> => ({ ok: true, result }), failed)
    // Exit only once the reply is written, or the parent could see the process end first.
    .then(sendReply)
    .catch((err) => {
      log.error(`sleep child: the reply could not be sent: ${errorMessage(err)}`, errorFields(err));
      return 1;
    })
    .then((code) => process.exit(code));
});
