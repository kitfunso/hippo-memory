import { evalStoreRules } from '../../infra/eval-switches.js';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import { adminActor } from '../../api/index.js';
import { dashboardDetailAfterWrite, dashboardMemoryDetail } from '../../api/dashboard/detail.js';
import { buildOverview, buildProjectDetail } from '../../api/dashboard/overview.js';
import { buildMemoryPage, buildSearch } from '../../api/dashboard/queries.js';
import { createSnapshotClock } from '../../api/dashboard/snapshot-clock.js';
import type { Context } from '../../api/types.js';
import { configReader } from '../../host/config-file.js';
import { defaultDashboardReads, defaultStore } from '../open-store.js';
import { envLossAversionRatio, envRuntimeSettings } from '../../base/util/env.js';
import { postReply } from '../../base/util/thread-reply.js';
import type { ReaderCall, ReaderInit, ReaderReply, ReaderValue } from './dashboard-reader.js';
import { failureReply } from './failure-reply.js';
import { rootInfra } from '../../infra/ports.js';

const DASHBOARD_ACTOR = 'dashboard';

function readerStore(
  hippoRoot: string,
  clock: { readonly nowMs: number; readonly wallMs: number },
) {
  const rules = evalStoreRules(envLossAversionRatio());
  const store = defaultStore(hippoRoot, rules);
  const reads = defaultDashboardReads(hippoRoot, rules);
  const stamps = createSnapshotClock(
    reads,
    () => clock.nowMs,
    () => clock.wallMs,
  );
  return { store, view: { reads, clock: stamps } };
}

function serveReads(port: MessagePort, { hippoRoot, tenantId }: ReaderInit): void {
  const loadConfig = configReader(envRuntimeSettings);
  const infra = rootInfra();
  const clock = { nowMs: 0, wallMs: 0 };
  const { store, view } = readerStore(hippoRoot, clock);
  const { reads } = view;
  const stamp = (fresh: boolean) => view.clock.at(tenantId, fresh);
  const context = (): Context => ({
    tenantId,
    actor: adminActor(DASHBOARD_ACTOR),
    store,
    config: loadConfig(hippoRoot),
    infra: infra(),
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
  answerInOrder(port, clock, run);
}

function answerInOrder(
  port: MessagePort,
  clock: { nowMs: number; wallMs: number },
  run: (call: ReaderCall) => Promise<ReaderValue>,
): void {
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

async function replyTo(
  call: ReaderCall,
  run: (call: ReaderCall) => Promise<ReaderValue>,
): Promise<ReaderReply> {
  try {
    return { id: call.id, ok: true, value: await run(call) };
  } catch (err) {
    return { id: call.id, ...failureReply(err) };
  }
}

function answer(port: MessagePort, reply: ReaderReply): void {
  postReply(port, {
    reply,
    transfer: [],
    failureOf: (err) => ({ id: reply.id, ...failureReply(err) }),
    what: `dashboard reader: reply ${reply.id}`,
  });
}

if (parentPort) {
  // SAFETY: dashboard-reader.ts is the only code that starts this file, and it passes a ReaderInit.
  serveReads(parentPort, workerData as ReaderInit);
}
