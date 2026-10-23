// The one write path for text no person typed into hippo: capture, compaction items and imported agent memories.
import { isContentWorthStoring } from '../../base/memory/memory-quality.js';
import type { DatabaseSyncLike } from '../../db/index.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { auditRejectionRefusal } from './audit-event.js';
import { stampOriginProject } from './entry-row.js';
import { writeEntryDbOnly } from './entry-writes.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import type { GatedWriteResult } from '../port/agent-import.js';
import type { StoreFiles } from './open.js';

/** Runs on the caller's handle so it nests in the caller's transaction (writeEntry would open a second handle and wait
 * on that lock); the caller mirrors after commit with an entry it stamped itself. The rejection audit lands inside that
 * transaction, which is safe because a batch that rolls back stays `summarised` and replay writes the audit again. */
export function gatedWrite(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entry: MemoryEntry,
  opts?: { actor?: string; worthCheck?: boolean },
): GatedWriteResult {
  // Off for imported agent memories: a person wrote those notes, and a one-line preference fails the check.
  if (opts?.worthCheck !== false && !isContentWorthStoring(entry.content)) return 'skipped:not-worth-storing';
  if (detectSecret(entry).flagged) return 'skipped:secret';
  try {
    writeEntryDbOnly(db, stampOriginProject(files, entry), opts);
    return 'written';
  } catch (err) {
    if (!(err instanceof RejectedValueError)) throw err;
    auditRejectionRefusal(db, err, opts?.actor ?? CLI_ACTOR);
    return 'skipped:rejected';
  }
}
