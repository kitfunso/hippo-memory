// AgentImport on hippo.db: each target holds one bare handle, and a container's calls run on it in one scope.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  closeHippoDb,
  isSqliteBusy,
  outsideRequestStores,
  withTrialScope,
  withWriteScope,
  type DatabaseSyncLike,
} from '../../db/index.js';
import { appendAuditEvent } from '../audit.js';
import {
  deleteDormantRow,
  dormantSnapshotsBySourcePrefix,
  readDormantSnapshot,
  replaceDormantEntry,
} from '../dormant.js';
import { stampOriginProject } from '../entry-row.js';
import { entryIdTakenAt, selectLiveEntriesBySourcePrefix, selectRowsOutsideSourcePrefixAt } from '../entry-reads.js';
import {
  renameEntrySourceAndOriginAt,
  renameEntrySourceAt,
  setEntryTagsInTx,
  supersedeEntryAt,
  writeEntryMirrors,
} from '../entry-writes.js';
import { gatedWrite } from '../gated-write.js';
import { updateStats } from '../index-and-stats.js';
import { removeEntryMirrors } from '../mirrors.js';
import { initStore, openBareHandle } from '../open.js';
import { projectTagReads } from '../project-tags.js';
import { findRejectedValue, rejectionDigest } from '../rejection.js';
import { setAsideRow } from '../set-aside.js';
import { markSummaryDirtyInTx } from '../summary-dirty.js';
import { resolveTenantId } from '../tenant.js';
import type { AgentImport, ContainerTx, ImportTarget } from '../port/agent-import.js';

function containerTx(db: DatabaseSyncLike, root: string): ContainerTx {
  return {
    liveBySourcePrefix: (tenantId, prefix) => selectLiveEntriesBySourcePrefix(db, tenantId, prefix),
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

function importTarget(db: DatabaseSyncLike, root: string, close: () => void): ImportTarget {
  const tenantId = resolveTenantId({});
  return {
    root,
    tenantId,
    liveBySourcePrefix: (prefix) => selectLiveEntriesBySourcePrefix(db, tenantId, prefix),
    rowsOutsideSourcePrefix: (prefix, origins) => selectRowsOutsideSourcePrefixAt(db, tenantId, prefix, origins),
    projectTagReads: () => projectTagReads(db, tenantId),
    inContainer: (scope, dryRun, work) => {
      const run = () => work(containerTx(db, root));
      return dryRun ? withTrialScope(db, scope, run) : withWriteScope(db, scope, run);
    },
    writeMirror: (entry) => writeEntryMirrors(root, entry),
    removeMirror: (id) => removeEntryMirrors(root, id),
    bumpRemembered: (count) => updateStats(root, { remembered: count }),
    close,
  };
}

export const sqliteAgentImport: AgentImport = {
  create: (root) => initStore(root),
  open: (root, opts) => {
    const db = openBareHandle(root, { busyWaitMs: opts.busyWaitMs });
    return importTarget(db, root, () => closeHippoDb(db));
  },
  openStandIn: () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-agent-memories-'));
    // Its folder is deleted at close, so a request scope must not keep the file open past that.
    const db = outsideRequestStores(() => openBareHandle(root));
    return importTarget(db, root, () => {
      closeHippoDb(db);
      fs.rmSync(root, { recursive: true, force: true });
    });
  },
  isBusy: (err) => isSqliteBusy(err),
};
