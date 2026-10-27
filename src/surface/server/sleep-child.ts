// Entry of the process that runs one POST /v1/sleep or MCP auto-sleep; sleep-offload.ts starts it
// and nothing imports it. The sleep modules alone: the api barrel loads far more than one sleep
// needs, and every sleep pays for the start.
import { evalStoreRules } from '../../infra/eval-switches.js';
import { sleepWholeStore } from '../../api/sleep/sleep.js';
import { autoSleepConsolidate } from '../../api/sleep/auto-sleep.js';
import { rootInfra } from '../../infra/ports.js';
import { resolveEmbeddingProvider } from '../../infra/embedding-provider.js';
import { configReader } from '../../host/config-file.js';
import { createHost } from '../../host/host.js';
import {
  defaultReach,
  defaultStore,
  runStoreRequest,
  saveVectorGraphFile,
  type StoreSession,
} from '../open-store.js';
import { envLossAversionRatio, envRuntimeSettings, envTenant } from '../../base/util/env.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { SleepJob, SleepMessage, SleepReply } from './sleep-offload.js';
import { failureReply } from './failure-reply.js';
import type { SleepResult } from '../../api/sleep/sleep.js';
import { contextReach } from '../../api/types.js';

type JobResult = SleepResult | Awaited<ReturnType<typeof autoSleepConsolidate>>;

// The vector graph build gives up this long before the server's deadline, so the child exits before
// it is killed.
const EXIT_MARGIN_MS = 5_000;

const loadConfig = configReader(envRuntimeSettings);
const storeIn = (session: StoreSession) => (root: string) =>
  defaultStore(root, { ...evalStoreRules(envLossAversionRatio()), session });
// The child runs one job, so its one root builds the ports and its Host once.
const childHost = createHost();
const childInfra = rootInfra(childHost);

/** The served sleep, with the reach `hippo sleep` probes, so it shares into the same global
 * store. */
function sleepJob(
  { hippoRoot, ...job }: Extract<SleepJob, { kind: 'sleep' }>,
  session: StoreSession,
): Promise<SleepResult> {
  const storeAt = storeIn(session);
  const store = storeAt(hippoRoot);
  const config = loadConfig(hippoRoot);
  const reach = contextReach(
    defaultReach({ hippoRoot, store, shared: undefined, openGlobal: storeAt, host: childHost }),
    loadConfig,
    resolveEmbeddingProvider,
    { ledger: store.ledger, folderFiles: store.folderFiles, config },
  );
  return sleepWholeStore(
    { tenantId: job.tenantId, actor: job.actor, store, reach, config, infra: childInfra() },
    job.opts,
  );
}

/** A sleep that changed the store saves its vector graph file, so a store whose server holds no
 * graph gets one. */
async function saveGraphAfter(job: SleepMessage): Promise<void> {
  if (job.kind !== 'sleep' || job.opts.dryRun) return;
  const { maxVectors } = loadConfig(job.hippoRoot).vectorGraph;
  await saveVectorGraphFile(job.hippoRoot, { maxVectors, deadline: job.deadline - EXIT_MARGIN_MS });
}

/** Resolves to the exit code once the channel has taken the reply, or failed to. */
function sendReply(reply: SleepReply<JobResult>): Promise<number> {
  return new Promise((resolve) => {
    process.send?.(reply, (sendErr: Error | null) => {
      if (sendErr) {
        log.error(
          `sleep child: sending the reply failed: ${errorMessage(sendErr)}`,
          errorFields(sendErr),
        );
      }
      resolve(sendErr ? 1 : 0);
    });
  });
}

process.once('message', (message) => {
  // SAFETY: sleep-offload.ts is the only writer on this channel and sends exactly one SleepMessage.
  const job = message as SleepMessage;
  const work = (session: StoreSession): Promise<JobResult> =>
    job.kind === 'consolidate'
      ? autoSleepConsolidate({
          store: storeIn(session)(job.hippoRoot),
          config: loadConfig(job.hippoRoot),
          tenantId: envTenant(),
          infra: childInfra(),
        })
      : sleepJob(job, session);
  // The server's own session and lock wait, so a busy store answers as it did when sleep ran in the
  // server.
  runStoreRequest(work, 'server')
    .then((result): SleepReply<JobResult> => ({ ok: true, result }), failureReply)
    // Exit only once the reply is written, or the parent could see the process end first.
    .then(async (reply) => {
      const code = await sendReply(reply);
      // After the reply, so the sleep's caller never waits on the build; the server's queue waits
      // for the exit.
      if (reply.ok) await saveGraphAfter(job);
      return code;
    })
    .catch((err) => {
      log.error(`sleep child: the reply could not be sent: ${errorMessage(err)}`, errorFields(err));
      return 1;
    })
    .then((code) => process.exit(code));
});
