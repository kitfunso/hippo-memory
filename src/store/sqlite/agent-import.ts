// AgentImport on hippo.db: reads on a bare handle, and a container's steps in one scope on a handle opened with
// openStore, whose mirror folders the commit's mirror files need.
import { errorFields, errorMessage, log } from '../../base/util/log.js';
import { withTrialScope, withWriteScope, type DatabaseSyncLike } from '../../db/index.js';
import { dormantSnapshotsBySourcePrefix } from './dormant-rows.js';
import { selectRowsHoldingOutsideSourcePrefix } from './entry-reads.js';
import { writeEntryMirrors } from './entry-writes.js';
import { removeEntryMirrors } from './mirrors.js';
import { openStore } from './handles.js';
import { waitingOpener, type Handles, type StoreFiles } from './open.js';
import { bound, type Bodies } from './bound.js';
import { liveUnder, runSteps } from './agent-import-steps.js';
import type { AgentImport, ContainerApplied, ContainerApply, MirrorFailure } from '../port/agent-import.js';

const importReadsBodies: Bodies<Omit<AgentImport, 'applyContainer'>> = {
  liveBySourcePrefix: liveUnder,
  dormantBySourcePrefix: dormantSnapshotsBySourcePrefix,
  rowsHoldingOutsideSourcePrefix: (db, tenantId, texts, prefix, origins) =>
    texts.map((text) => selectRowsHoldingOutsideSourcePrefix(db, tenantId, text, prefix, origins)),
};

function applyContainer(db: DatabaseSyncLike, files: StoreFiles, plan: ContainerApply): ContainerApplied {
  const run = () => runSteps(db, files, plan);
  const done = plan.dryRun ? withTrialScope(db, 'sync_container', run) : withWriteScope(db, 'sync_container', run);
  if (done === null) return { kind: 'changed' };
  if (plan.dryRun) return { kind: 'applied', outcomes: done.outcomes, unpurged: [] };
  for (const entry of done.mirror) writeEntryMirrors(files.hippoRoot, entry);
  return { kind: 'applied', outcomes: done.outcomes, unpurged: purgeMirrors(files.hippoRoot, done.purge) };
}

function purgeMirrors(hippoRoot: string, ids: readonly string[]): MirrorFailure[] {
  const failed: MirrorFailure[] = [];
  for (const id of ids) {
    try {
      removeEntryMirrors(hippoRoot, id);
    } catch (err) {
      // A legacy-mirror import on an empty store would bring the row back live, and the next sync sets it aside again.
      log.debug(`agent import: ${id} failed`, errorFields(err));
      failed.push({ id, message: errorMessage(err) });
    }
  }
  return failed;
}

/** The import's group; `busyWaitMs` replaces each handle's lock wait, as a compaction hook's import asks. */
export function sqliteAgentImport({ on, files }: Handles, busyWaitMs?: number): AgentImport {
  return {
    ...bound(on, importReadsBodies, waitingOpener(busyWaitMs)),
    ...bound<Pick<AgentImport, 'applyContainer'>>(
      on,
      { applyContainer: (db, plan) => applyContainer(db, files, plan) },
      waitingOpener(busyWaitMs, openStore),
    ),
  };
}
