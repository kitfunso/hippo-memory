// The lesson and batch writes sleep and learn make on hippo.db's local tier.

import type { MemoryEntry } from '../memory/entry.js';
import type { HeldText } from '../ports/store/types.js';

/** The reads and writes behind git auto-learn's batch. */
export interface LessonWrites {
  /** Content, source and origin of the tenant's rows that may hold one of `texts`, as
   * `captures.textsHolding` reads them, among the rows a team member or `ownScope`'s owner
   * may touch. */
  textsHolding(
    tenantId: string,
    texts: readonly string[],
    ownScope: string | null,
  ): Promise<HeldText[]>;
  /** Contents of the tenant's team-visible rows tagged `tag`; with `origins`, only those
   * projects' and user-global. */
  contentsWithTag(tenantId: string, tag: string, origins?: readonly string[]): Promise<string[]>;
  /** Writes each entry in one transaction; a rejected value writes its refusal row and is
   * skipped. Resolves to the ids written. */
  writeSkippingRejected(entries: readonly MemoryEntry[], actor: string): Promise<string[]>;
  /** Rewrites each entry in one transaction, all or none. */
  writeTogether(entries: readonly MemoryEntry[]): Promise<void>;
}
