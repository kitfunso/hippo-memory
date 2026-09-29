// The one write path for text no person typed: capture and compaction items.
import { isContentWorthStoring } from './audit.js';
import type { DatabaseSyncLike } from './db.js';
import type { MemoryEntry } from './memory.js';
import { RejectedValueError } from './rejection.js';
import { detectSecret } from './secret-detect.js';
import { auditRejectionRefusal, stampOriginProject, writeEntryDbOnly } from './store.js';

export type GatedWriteResult = 'written' | 'skipped:not-worth-storing' | 'skipped:secret' | 'skipped:rejected';

/** Runs on the caller's handle so it nests in the caller's transaction (writeEntry would open a second handle and wait on that lock); the caller mirrors after commit with an entry it stamped itself. The rejection audit lands inside that transaction, which is safe because a batch that rolls back stays `summarised` and replay writes the audit again. */
export function gatedWrite(
  db: DatabaseSyncLike,
  hippoRoot: string,
  entry: MemoryEntry,
  opts?: { actor?: string },
): GatedWriteResult {
  if (!isContentWorthStoring(entry.content)) return 'skipped:not-worth-storing';
  if (detectSecret(entry).flagged) return 'skipped:secret';
  try {
    writeEntryDbOnly(db, stampOriginProject(hippoRoot, entry), opts);
    return 'written';
  } catch (err) {
    if (!(err instanceof RejectedValueError)) throw err;
    auditRejectionRefusal(db, err, opts?.actor ?? 'cli');
    return 'skipped:rejected';
  }
}
