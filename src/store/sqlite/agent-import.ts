// AgentImport on hippo.db: each target holds one bare handle, and a container's calls run on it in one scope.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeHippoDb,
  isSqliteBusy,
  openHippoDb,
  outsideRequestStores,
  withTrialScope,
  withWriteScope,
  type DatabaseSyncLike,
} from '../../db/index.js';
import { appendAuditEvent } from './audit.js';
import {
  deleteDormantRow,
  dormantSnapshotsBySourcePrefix,
  readDormantSnapshot,
  replaceDormantEntry,
} from './dormant-rows.js';
import { stampOriginProject } from './entry-row.js';
import {
  entryIdTakenAt,
  selectLiveEntriesBySourcePrefix,
  selectRowsHoldingOutsideSourcePrefixAt,
} from './entry-reads.js';
import {
  renameEntrySourceAndOriginAt,
  renameEntrySourceAt,
  setEntryTagsInTx,
  supersedeEntryAt,
  writeEntryMirrors,
} from './entry-writes.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsAt } from './index-and-stats.js';
import { removeEntryMirrors } from './mirrors.js';
import { initStore, onHandle, openStore } from './handles.js';
import { projectTagReads } from './project-tags.js';
import { findRejectedValue } from './rejection.js';
import { rejectionDigest } from '../../core/rejection-digest.js';
import type { MemoryEntry } from '../../core/memory.js';
import { READ_PAGE_ROWS, rowsInPages } from '../../util/pages.js';
import { setAsideRow } from './set-aside.js';
import { markSummaryDirtyInTx } from './summary-dirty.js';
import type { AgentImport, ContainerTx, ImportTarget } from '../port/agent-import.js';
import type { EntryCursor } from '../port/consolidation.js';

/** The tenant's live rows under `prefix`, one bounded statement per page, read as the caller walks them. */
function liveUnder(db: DatabaseSyncLike, tenantId: string, prefix: string): Generator<MemoryEntry> {
  return rowsInPages((after?: EntryCursor) =>
    selectLiveEntriesBySourcePrefix(db, tenantId, prefix, { limit: READ_PAGE_ROWS, after }),
  );
}

function containerTx(db: DatabaseSyncLike, root: string): ContainerTx {
  return {
    liveBySourcePrefix: (tenantId, prefix) => liveUnder(db, tenantId, prefix),
    dormantBySourcePrefix: (tenantId, prefix) => dormantSnapshotsBySourcePrefix(db, tenantId, prefix),
    readDormant: (tenantId, id) => readDormantSnapshot(db, tenantId, id),
    deleteDormant: (tenantId, id) => {
      deleteDormantRow(db, tenantId, id);
    },
    replaceDormant: (tenantId, id, entry) => replaceDormantEntry(db, tenantId, id, entry),
    entryIdTaken: (id) => entryIdTakenAt(db, id),
    isRejected: (tenantId, text) => findRejectedValue(db, tenantId, rejectionDigest(text)) !== null,
    renameSource: (tenantId, id, from, to) => renameEntrySourceAt(db, tenantId, id, from, to),
    renameSourceAndOrigin: (tenantId, id, move) => renameEntrySourceAndOriginAt(db, tenantId, id, move),
    setTags: (entry) => setEntryTagsInTx(db, entry),
    supersede: (tenantId, id, newId) => supersedeEntryAt(db, tenantId, id, newId),
    markSummaryDirty: (summaryId, tenantId, actor) => markSummaryDirtyInTx(db, summaryId, tenantId, actor),
    appendAudit: (event) => appendAuditEvent(db, event),
    gatedWrite: (entry, opts) => gatedWrite(db, root, entry, opts),
    setAside: (tag, row, why) => setAsideRow(db, tag, row, why),
    stampOrigin: (entry) => stampOriginProject(root, entry),
  };
}

function importTarget(db: DatabaseSyncLike, root: string, tenantId: string, close: () => void): ImportTarget {
  return {
    root,
    tenantId,
    liveBySourcePrefix: (prefix) => [...liveUnder(db, tenantId, prefix)],
    rowsHoldingOutsideSourcePrefix: (text, prefix, origins) =>
      selectRowsHoldingOutsideSourcePrefixAt(db, tenantId, text, prefix, origins),
    projectTagReads: () => projectTagReads(db, tenantId),
    inContainer: (scope, dryRun, work) => {
      const run = () => work(containerTx(db, root));
      return dryRun ? withTrialScope(db, scope, run) : withWriteScope(db, scope, run);
    },
    writeMirror: (entry) => writeEntryMirrors(root, entry),
    removeMirror: (id) => removeEntryMirrors(root, id),
    bumpRemembered: (count) =>
      onHandle(root, (own) => updateStatsAt(own, { hippoRoot: root }, { remembered: count }), openStore),
    close,
  };
}

export const sqliteAgentImport: AgentImport = {
  create: (root) => initStore(root),
  open: (root, tenantId, opts) => {
    const db = openHippoDb(root, { busyWaitMs: opts.busyWaitMs });
    return importTarget(db, root, tenantId, () => closeHippoDb(db));
  },
  openStandIn: (tenantId) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-agent-memories-'));
    // Its folder is deleted at close, so a request scope must not keep the file open past that.
    const db = outsideRequestStores(() => openHippoDb(root));
    return importTarget(db, root, tenantId, () => {
      closeHippoDb(db);
      fs.rmSync(root, { recursive: true, force: true });
    });
  },
  isBusy: (err) => isSqliteBusy(err),
};
