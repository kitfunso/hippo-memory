import { evalStoreRules } from '../../infra/eval-switches.js';
import { sleepWholeStore } from '../../api/sleep/sleep.js';
import { autoSleepConsolidate } from '../../api/sleep/auto-sleep.js';
import { sleepWasRefused } from '../../api/sleep/one-sleep.js';
import { rootInfra } from '../../infra/ports.js';
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

const EXIT_MARGIN_MS = 5_000;

const loadConfig = configReader(envRuntimeSettings);
const storeIn = (session: StoreSession) => (root: string) =>
  defaultStore(root, { ...evalStoreRules(envLossAversionRatio()), session });
const childHost = createHost();
const childInfra = rootInfra(childHost);

function sleepJob(
  { hippoRoot, ...job }: Extract<SleepJob, { kind: 'sleep' }>,
  session: StoreSession,
): Promise<SleepResult> {
  const storeAt = storeIn(session);
  const store = storeAt(hippoRoot);
  const config = loadConfig(hippoRoot);
  const infra = childInfra();
  const reach = contextReach(
    defaultReach({ hippoRoot, store, shared: undefined, openGlobal: storeAt, host: childHost }),
    loadConfig,
    infra.embedderFor,
    { ledger: store.ledger, folderFiles: store.folderFiles, config },
  );
  return sleepWholeStore(
    { tenantId: job.tenantId, actor: job.actor, store, reach, config, infra },
    job.opts,
  );
}

async function saveGraphAfter(job: SleepMessage, result: JobResult): Promise<void> {
  if (job.kind !== 'sleep' || job.opts.dryRun || sleepWasRefused(result)) return;
  const { maxVectors } = loadConfig(job.hippoRoot).vectorGraph;
  await saveVectorGraphFile(job.hippoRoot, { maxVectors, deadline: job.deadline - EXIT_MARGIN_MS });
}

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
  runStoreRequest(work, 'server')
    .then((result): SleepReply<JobResult> => ({ ok: true, result }), failureReply)
    // Exit only once the reply is written, or the parent could see the process end first.
    .then(async (reply) => {
      const code = await sendReply(reply);
      if (reply.ok) await saveGraphAfter(job, reply.result);
      return code;
    })
    .catch((err) => {
      log.error(`sleep child: the reply could not be sent: ${errorMessage(err)}`, errorFields(err));
      return 1;
    })
    .then((code) => process.exit(code));
});
