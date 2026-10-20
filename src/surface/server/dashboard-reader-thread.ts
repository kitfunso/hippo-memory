// Entry of the dashboard's reader thread; dashboard-reader.ts starts it and nothing imports it. It owns the snapshot
// clock and answers each read through the api's dashboard functions.
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { adminActor } from '../../api/index.js';
import { dashboardDetailAfterWrite, dashboardMemoryDetail } from '../../api/dashboard/detail.js';
import { buildOverview, buildProjectDetail } from '../../api/dashboard/overview.js';
import { buildMemoryPage, buildSearch } from '../../api/dashboard/queries.js';
import { createSnapshotClock } from '../../api/dashboard/snapshot-clock.js';
import type { Context } from '../../api/types.js';
import { configReader } from '../../base/config/config.js';
import { isStoreBusy } from '../../store/port.js';
import { sqliteDashboardReads, sqliteStore } from '../../store/sqlite/index.js';
import { envLossAversionRatio, envRuntimeSettings } from '../../base/util/env.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import type { ReaderCall, ReaderInit, ReaderReply, ReaderValue } from './dashboard-reader.js';

// The audit log's actor for every dashboard write.
const DASHBOARD_ACTOR = 'dashboard';

/** The thread is its own root, so it reads the ratio its store and dashboard reads score strength by. */
function readerStore(hippoRoot: string, clock: { readonly nowMs: number; readonly wallMs: number }) {
  const lossAversion = { lossAversionRatio: envLossAversionRatio() };
  const store = sqliteStore(hippoRoot, lossAversion);
  const reads = sqliteDashboardReads(hippoRoot, lossAversion);
  const stamps = createSnapshotClock(
    reads,
    () => clock.nowMs,
    () => clock.wallMs,
  );
  return { store, view: { reads, clock: stamps } };
}

function serveReads(port: MessagePort, { hippoRoot, tenantId }: ReaderInit): void {
  const loadConfig = configReader(envRuntimeSettings);
  // Set from each call, so each read is dated and aged by the clocks the server read when the request came in.
  const clock = { nowMs: 0, wallMs: 0 };
  const { store, view } = readerStore(hippoRoot, clock);
  const { reads } = view;
  const stamp = (fresh: boolean) => view.clock.at(tenantId, fresh);
  // A fresh Context per call, so a config edit shows on the next request.
  const context = (): Context => ({
    hippoRoot,
    tenantId,
    actor: adminActor(DASHBOARD_ACTOR),
    store,
    config: loadConfig(hippoRoot),
  });
  const run = async (call: ReaderCall): Promise<ReaderValue> => {
    const fresh = 'fresh' in call && call.fresh;
    switch (call.op) {
      case 'overview':
        return buildOverview(reads, await stamp(fresh));
      case 'project':
        return buildProjectDetail(reads, await stamp(fresh), call.key);
      case 'memories':
        return buildMemoryPage(reads, await stamp(fresh), call.key, call.query);
      case 'search':
        return buildSearch(reads, await stamp(fresh), call.text);
      case 'memory':
        return dashboardMemoryDetail(context(), view, call.memoryId, { fresh, nowMs: call.nowMs });
      case 'written':
        return dashboardDetailAfterWrite(context(), view, call, call.nowMs);
      case 'close':
        await reads.close();
        await store.close();
        return null;
    }
  };
  // One call at a time, in the order sent, so a write's invalidation lands before the read that follows it.
  let turn: Promise<void> = Promise.resolve();
  port.on('message', (call: ReaderCall) => {
    turn = turn.then(async () => {
      clock.nowMs = call.nowMs;
      clock.wallMs = call.wallMs;
      answer(port, await replyTo(call, run));
      if (call.op === 'close') port.close();
    });
  });
}

function failed<E>(id: number, err: E): ReaderReply {
  const stack = err instanceof Error ? err.stack : undefined;
  return { id, ok: false, busy: isStoreBusy(err), message: errorMessage(err), stack };
}

// The server logs the failure with its request, so the thread only hands it back.
async function replyTo(call: ReaderCall, run: (call: ReaderCall) => Promise<ReaderValue>): Promise<ReaderReply> {
  try {
    return { id: call.id, ok: true, value: await run(call) };
  } catch (err) {
    return failed(call.id, err);
  }
}

/** Posts the reply; one that cannot be copied to the server becomes its failure, so no request waits forever. */
function answer(port: MessagePort, reply: ReaderReply): void {
  try {
    port.postMessage(reply);
  } catch (err) {
    log.error(`dashboard reader: reply ${reply.id} could not be sent: ${errorMessage(err)}`, errorFields(err));
    port.postMessage(failed(reply.id, err));
  }
}

if (parentPort) {
  // SAFETY: dashboard-reader.ts is the only code that starts this file, and it passes a ReaderInit.
  serveReads(parentPort, workerData as ReaderInit);
}
