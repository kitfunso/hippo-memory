// What a dirty DAG summary settles to after a rebuild or a fresh build, with the audit rows and log line each writes;
// the store lands it in one write while the summary is still dirty.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { rejectionDigest } from '../../base/records/rejection-digest.js';
import { log } from '../../base/util/log.js';
import { DIGEST_DISPLAY_CHARS } from '../../base/util/token-text.js';
import type { StoreWith } from '../../base/ports/store.js';
import type { SummarySettled } from '../../base/ports/store/consolidation.js';

/** A rebuild's result for one summary; `bumpRebuildCount` is false for the zero-child case, true for a normal one. */
export interface RebuildPatch {
  /** New content for a normal rebuild; the summary's own for zero children. */
  content: string;
  descendantCount: number;
  earliestAt: string | null;
  latestAt: string | null;
  bumpRebuildCount: boolean;
  zeroChildren: boolean;
  actor: string;
}

/** Lands `patch` on the summary while it is still dirty: `changed` false means another sleep settled it first, and
 * `refused` means a tombstone kept the new content out while the counts still landed. */
export async function applyRebuild(
  store: StoreWith<'consolidation'>,
  summary: MemoryEntry,
  patch: RebuildPatch,
): Promise<SummarySettled> {
  const { id, tenantId } = summary;
  const content = patch.bumpRebuildCount ? { text: patch.content, rebuiltAt: new Date().toISOString() } : undefined;
  const settled = await store.consolidation.settleSummary({
    id,
    tenantId,
    actor: patch.actor,
    fields: { content, descendantCount: patch.descendantCount, earliestAt: patch.earliestAt, latestAt: patch.latestAt },
    audit: [
      {
        tenantId,
        actor: patch.actor,
        op: 'summary_rebuilt',
        targetId: id,
        metadata: {
          // The summary's own level: L2 -> 2, L3 -> 3.
          dag_level: summary.dagLevel,
          source: 'E3-rebuild',
          zero_children: patch.zeroChildren,
          descendant_count: patch.descendantCount,
        },
      },
    ],
  });
  if (settled.refused) {
    log.warn(
      `applyRebuildResult: refused rebuild content for ${id} \u2014 matches a rejected value ` +
        `(digest ${rejectionDigest(patch.content).slice(0, DIGEST_DISPLAY_CHARS)}...); ` +
        `metadata updated, content unchanged`,
    );
  }
  return settled;
}

/** Clears the dirty mark a fresh summary got from linking its own children, or the same sleep would rebuild it at
 * twice the model cost; `source` tells an L2 build from an L3 one in the audit row. */
export async function settleFreshSummary(
  store: StoreWith<'consolidation'>,
  summary: Pick<MemoryEntry, 'id' | 'tenantId' | 'dagLevel'>,
  actor: string,
  source: string,
): Promise<void> {
  const { id, tenantId } = summary;
  await store.consolidation.settleSummary({
    id,
    tenantId,
    actor,
    audit: [
      { tenantId, actor, op: 'summary_marked_clean', targetId: id, metadata: { dag_level: summary.dagLevel, source } },
    ],
  });
}
