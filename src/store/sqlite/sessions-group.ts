// hippo.db's Sessions group: snapshots, session events, handoffs, working memory and session-owner binding.
import {
  loadHandoffById, loadLatestHandoff, saveSessionHandoff, stampHandoffOutcome, writeSessionEndHandoff,
} from '../handoffs.js';
import type { Sessions } from '../port-groups.js';
import type { Sync } from '../port.js';
import {
  appendSessionEvent, clearActiveTaskSnapshot, closeTaskSnapshotsForSession, listSessionEvents,
  loadActiveTaskSnapshot, loadFreshActiveTaskSnapshot, saveActiveTaskSnapshot, sessionOwnerOrBind,
} from '../sessions.js';
import { wmClear, wmPush, wmRead } from '../working-memory.js';

export function sqliteSessions(hippoRoot: string): Sync<Sessions> {
  return {
    saveSnapshot: (tenantId, snapshot, key) => saveActiveTaskSnapshot(hippoRoot, tenantId, snapshot, key ?? undefined),
    loadSnapshot: (tenantId, key) => loadActiveTaskSnapshot(hippoRoot, tenantId, key ?? undefined),
    loadFreshSnapshot: (tenantId, opts, key) =>
      loadFreshActiveTaskSnapshot(hippoRoot, tenantId, opts, key ?? undefined),
    clearSnapshot: (tenantId, clearedStatus) => clearActiveTaskSnapshot(hippoRoot, tenantId, clearedStatus),
    closeSessionSnapshots: (tenantId, sessionId, status, key) =>
      closeTaskSnapshotsForSession(hippoRoot, tenantId, sessionId, status, key ?? undefined),
    appendEvent: (tenantId, event) => appendSessionEvent(hippoRoot, tenantId, event),
    listEvents: (tenantId, { sessionId, task, limit }) =>
      listSessionEvents(hippoRoot, tenantId, { session_id: sessionId, task, limit }),
    saveHandoff: (tenantId, handoff, key) => saveSessionHandoff(hippoRoot, tenantId, handoff, key ?? undefined),
    latestHandoff: (tenantId, sessionId, filter, key) =>
      loadLatestHandoff(hippoRoot, tenantId, sessionId ?? undefined, filter, key ?? undefined),
    handoffById: (tenantId, id) => loadHandoffById(hippoRoot, tenantId, id),
    stampHandoffOutcome: (tenantId, sessionId, outcome) =>
      stampHandoffOutcome(hippoRoot, tenantId, sessionId, outcome),
    writeSessionEndHandoff: (tenantId, request) => writeSessionEndHandoff(hippoRoot, { ...request, tenantId }),
    pushWorkingMemory: (tenantId, item) => wmPush(hippoRoot, { ...item, tenantId }),
    readWorkingMemory: (tenantId, filter) => wmRead(hippoRoot, { ...filter, tenantId }),
    clearWorkingMemory: (tenantId, filter) => wmClear(hippoRoot, { ...filter, tenantId }),
    bindSessionOwner: (tenantId, sessionId, owner, retentionMs) =>
      sessionOwnerOrBind(hippoRoot, { tenantId, sessionId, owner, retentionMs }),
  };
}

/** The group as a served store answers it: a throw rejects as another store's would. */
export function servedSessions(sync: Sync<Sessions>): Sessions {
  return {
    saveSnapshot: async (tenantId, snapshot, key) => sync.saveSnapshot(tenantId, snapshot, key),
    loadSnapshot: async (tenantId, key) => sync.loadSnapshot(tenantId, key),
    loadFreshSnapshot: async (tenantId, opts, key) => sync.loadFreshSnapshot(tenantId, opts, key),
    clearSnapshot: async (tenantId, clearedStatus) => sync.clearSnapshot(tenantId, clearedStatus),
    closeSessionSnapshots: async (tenantId, sessionId, status, key) =>
      sync.closeSessionSnapshots(tenantId, sessionId, status, key),
    appendEvent: async (tenantId, event) => sync.appendEvent(tenantId, event),
    listEvents: async (tenantId, opts) => sync.listEvents(tenantId, opts),
    saveHandoff: async (tenantId, handoff, key) => sync.saveHandoff(tenantId, handoff, key),
    latestHandoff: async (tenantId, sessionId, filter, key) => sync.latestHandoff(tenantId, sessionId, filter, key),
    handoffById: async (tenantId, id) => sync.handoffById(tenantId, id),
    stampHandoffOutcome: async (tenantId, sessionId, outcome) =>
      sync.stampHandoffOutcome(tenantId, sessionId, outcome),
    writeSessionEndHandoff: async (tenantId, request) => sync.writeSessionEndHandoff(tenantId, request),
    pushWorkingMemory: async (tenantId, item) => sync.pushWorkingMemory(tenantId, item),
    readWorkingMemory: async (tenantId, filter) => sync.readWorkingMemory(tenantId, filter),
    clearWorkingMemory: async (tenantId, filter) => sync.clearWorkingMemory(tenantId, filter),
    bindSessionOwner: async (tenantId, sessionId, owner, retentionMs) =>
      sync.bindSessionOwner(tenantId, sessionId, owner, retentionMs),
  };
}
