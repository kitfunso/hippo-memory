// hippo.db's Sessions group: snapshots, session events, handoffs, working memory and session-owner binding.
import {
  loadHandoffByIdAt,
  loadLatestHandoffAt,
  saveSessionHandoffAt,
  stampHandoffOutcomeAt,
  writeSessionEndHandoffAt,
} from '../handoffs.js';
import type { Sessions } from '../port-groups.js';
import type { Sync } from '../port.js';
import {
  appendSessionEventAt,
  clearActiveTaskSnapshotAt,
  closeTaskSnapshotsForSessionAt,
  listSessionEventsAt,
  loadActiveTaskSnapshotAt,
  loadFreshActiveTaskSnapshotAt,
  saveActiveTaskSnapshotAt,
  sessionOwnerOrBindAt,
} from '../sessions.js';
import { wmClearAt, wmPushAt, wmReadAt } from '../working-memory.js';
import type { OnHandle } from '../open.js';
import { openStore } from './handles.js';

export function sqliteSessions(on: OnHandle): Sync<Sessions> {
  return {
    saveSnapshot: (tenantId, snapshot, key) =>
      on((db, files) => saveActiveTaskSnapshotAt(db, files, tenantId, snapshot, key ?? undefined), openStore),
    loadSnapshot: (tenantId, key) =>
      on((db, files) => loadActiveTaskSnapshotAt(db, files, tenantId, key ?? undefined), openStore),
    loadFreshSnapshot: (tenantId, opts, key) =>
      on((db, files) => loadFreshActiveTaskSnapshotAt(db, files, tenantId, opts, key ?? undefined), openStore),
    clearSnapshot: (tenantId, clearedStatus) =>
      on((db, files) => clearActiveTaskSnapshotAt(db, files, tenantId, clearedStatus), openStore),
    closeSessionSnapshots: (tenantId, sessionId, status, key) =>
      on((db) => closeTaskSnapshotsForSessionAt(db, tenantId, sessionId, status, key ?? undefined), openStore),
    appendEvent: (tenantId, event) => on((db, files) => appendSessionEventAt(db, files, tenantId, event), openStore),
    listEvents: (tenantId, { sessionId, task, limit }) =>
      on((db) => listSessionEventsAt(db, tenantId, { session_id: sessionId, task, limit }), openStore),
    saveHandoff: (tenantId, handoff, key) =>
      on((db) => saveSessionHandoffAt(db, tenantId, handoff, key ?? undefined), openStore),
    latestHandoff: (tenantId, sessionId, filter, key) =>
      on((db) => loadLatestHandoffAt(db, tenantId, sessionId ?? undefined, filter, key ?? undefined), openStore),
    handoffById: (tenantId, id) => on((db) => loadHandoffByIdAt(db, tenantId, id), openStore),
    stampHandoffOutcome: (tenantId, sessionId, outcome) =>
      on((db) => stampHandoffOutcomeAt(db, tenantId, sessionId, outcome), openStore),
    writeSessionEndHandoff: (tenantId, request) =>
      on((db, files) => writeSessionEndHandoffAt(db, files, { ...request, tenantId }), openStore),
    pushWorkingMemory: (tenantId, item) => on((db) => wmPushAt(db, { ...item, tenantId }), openStore),
    readWorkingMemory: (tenantId, filter) => on((db) => wmReadAt(db, { ...filter, tenantId }), openStore),
    clearWorkingMemory: (tenantId, filter) => on((db) => wmClearAt(db, { ...filter, tenantId }), openStore),
    bindSessionOwner: (tenantId, sessionId, owner, retentionMs) =>
      on((db) => sessionOwnerOrBindAt(db, { tenantId, sessionId, owner, retentionMs })),
  };
}
