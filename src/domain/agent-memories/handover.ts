// Design 2's handover: rows the store-less hook path left in the global store, under this project's origin, for
// containers its store now syncs.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { errorMessage } from '../../base/util/log.js';
import {
  isInitialized,
  projectNames,
  resolveGlobalRootDir,
  resolveProjectIdentity,
} from '../../base/scope/project-identity.js';
import type { ContainerApply, ImportStep, MirrorFailure } from '../../store/port/agent-import.js';
import type { ContainerWork } from './container-view.js';
import { namesFoldedInto } from './project-folds.js';
import { toolReport, type ImportReport } from './report.js';
import { containerId, containerPrefix, splitSource } from './source.js';
import type { SyncOptions } from './sync.js';
import type { ImportStore } from './types.js';

export async function handOver(
  synced: readonly ContainerWork[],
  projectRoot: string,
  opts: Pick<SyncOptions, 'stores' | 'busyWaitMs' | 'tenantId' | 'machine'>,
  report: ImportReport,
): Promise<void> {
  const globalRoot = resolveGlobalRootDir();
  if (synced.length === 0 || !isInitialized(globalRoot)) return;
  let store: ImportStore | undefined;
  try {
    store = opts.stores.open(globalRoot, { busyWaitMs: opts.busyWaitMs });
    // A folder with no git and no marker wrote as '' before its store existed, and as its own name after.
    // Names folded into this project's in the global store were its rows too.
    const names = projectNames(resolveProjectIdentity(projectRoot));
    const folded = await namesFoldedInto(store.projectTags, opts.tenantId, names);
    const origins = [...new Set([...names, ...folded, ''])];
    const at = { origins, tenantId: opts.tenantId, platform: opts.machine.platform, report };
    for (const work of synced) await handOverContainer(store, work, at);
  } catch (err) {
    report.warnings.push(
      `global copies not handed over: ${opts.stores.isBusy(err) ? 'the global store was busy' : errorMessage(err)}`,
    );
  } finally {
    await store?.close();
  }
}

/** One project's mirror purges that failed after a commit, as warnings. */
export function warnUnpurged(unpurged: readonly MirrorFailure[], report: ImportReport): void {
  for (const { id, message } of unpurged) report.warnings.push(`mirror of ${id} not removed: ${message}`);
}

interface HandOverContainerOptions {
  readonly origins: readonly string[];
  readonly tenantId: string;
  readonly platform: NodeJS.Platform;
  readonly report: ImportReport;
}

/** The container's tagged global rows set aside in one transaction, planned once more if they changed meanwhile. */
async function handOverContainer(store: ImportStore, work: ContainerWork, at: HandOverContainerOptions): Promise<void> {
  const prefixes = at.origins.map((origin) =>
    containerPrefix(work.tool.id, containerId(work.container.path, work.container.scope, at.platform, origin)),
  );
  for (let round = 0; round < 2; round++) {
    const applied = await store.agentImport.applyContainer(await handOverPlan(store, work, at.tenantId, prefixes));
    if (applied.kind === 'changed') continue;
    toolReport(at.report, work.tool.id).tally.handedOver += applied.outcomes.length;
    warnUnpurged(applied.unpurged, at.report);
    return;
  }
  at.report.warnings.push(
    `global copies of ${work.container.path} not handed over: the global store changed meanwhile`,
  );
}

async function handOverPlan(
  store: ImportStore,
  work: ContainerWork,
  tenantId: string,
  prefixes: readonly string[],
): Promise<ContainerApply> {
  // A note the local pass could not read has no local row yet, so its global copy stays until it does.
  const unread = new Set(work.container.skipped);
  const tag = work.tool.tag;
  const rows: MemoryEntry[] = [];
  const steps: ImportStep[] = [];
  for (const prefix of prefixes) {
    for (const row of await store.agentImport.liveBySourcePrefix(tenantId, prefix)) {
      rows.push(row);
      if (row.tags.includes(tag) && !unread.has(splitSource(row.source, prefix).key)) {
        steps.push({ kind: 'setAside', id: row.id, why: 'handover' });
      }
    }
  }
  const planned = rows.map((row) => ({ id: row.id, source: row.source, tagged: row.tags.includes(tag) }));
  return { tenantId, dryRun: false, tag, prefixes, rows: planned, steps };
}
