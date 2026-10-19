// Entry of the dashboard's reader thread; dashboard-reader.ts starts it and nothing imports it. It owns the snapshot
// cache and answers each read through the api's dashboard functions.
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { adminActor } from '../api/index.js';
import { dashboardDetailAfterWrite, dashboardMemoryDetail } from '../api/dashboard/detail.js';
import { buildMemoryPage, buildOverview, buildProjectDetail, buildSearch } from '../api/dashboard/queries.js';
import { createSnapshotService } from '../api/dashboard/snapshot.js';
import type { ContextWith } from '../api/types.js';
import { configReader } from '../core/config.js';
import { isStoreBusy } from '../store/port.js';
import { sqliteStore } from '../store/sqlite/store.js';
import { envLossAversionRatio, envRuntimeSettings } from '../util/env.js';
import { errorFields, errorMessage, log } from '../util/log.js';
import type { ReaderCall, ReaderInit, ReaderReply, ReaderValue } from './dashboard-reader.js';

// The audit log's actor for every dashboard write.
const DASHBOARD_ACTOR = 'dashboard';

/** The thread is its own root, so it reads the ratio its store and snapshots score strength by. */
function readerStore(hippoRoot: string, clock: { readonly nowMs: number; readonly wallMs: number }) {
  const lossAversion = { lossAversionRatio: envLossAversionRatio() };
  const store = sqliteStore(hippoRoot, lossAversion);
  const snapshots = createSnapshotService(
    store.localFiles.dashboard,
    lossAversion,
    () => clock.nowMs,
    () => clock.wallMs,
  );
  return { store, snapshots };
}

function serveReads(port: MessagePort, { hippoRoot, tenantId }: ReaderInit): void {
  const loadConfig = configReader(envRuntimeSettings);
  // Set from each call, so the snapshot is dated and aged by the clocks the server read when the request came in.
  const clock = { nowMs: 0, wallMs: 0 };
  const { store, snapshots } = readerStore(hippoRoot, clock);
  // A fresh Context per call, so a config edit shows on the next request.
  const context = (): ContextWith<'localFiles'> => ({
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
        return buildOverview(snapshots.get(tenantId, fresh));
      case 'project':
        return buildProjectDetail(snapshots.get(tenantId, fresh), call.key);
      case 'memories':
        return buildMemoryPage(snapshots.get(tenantId, fresh), call.key, call.query);
      case 'search':
        return buildSearch(snapshots.get(tenantId, fresh), call.text);
      case 'memory':
        return dashboardMemoryDetail(context(), snapshots, call.memoryId, { fresh, nowMs: call.nowMs });
      case 'written':
        return dashboardDetailAfterWrite(context(), snapshots, call, call.nowMs);
      case 'close':
        snapshots.close();
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
