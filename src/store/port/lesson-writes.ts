import type { MemoryEntry } from '../../core/memory.js';
import type { HeldText } from './types.js';

/** The reads and writes behind git auto-learn's batch. */
export interface LessonWrites {
  /** Content, source and origin of the tenant's rows holding any of `words`, among the rows a team member or
   * `ownScope`'s owner may touch. */
  textsHoldingWords(tenantId: string, words: readonly string[], ownScope: string | null): Promise<HeldText[]>;
  /** Contents of the tenant's team-visible rows tagged `tag`; with `origins`, only those projects' and user-global. */
  contentsWithTag(tenantId: string, tag: string, origins?: readonly string[]): Promise<string[]>;
  /** Writes each entry in one transaction; a rejected value writes
   * its refusal row and is skipped. Resolves to the ids written. */
  writeSkippingRejected(entries: readonly MemoryEntry[], actor: string): Promise<string[]>;
  /** Rewrites each entry in one transaction, all or none. */
  writeTogether(entries: readonly MemoryEntry[]): Promise<void>;
  /** Adds `count` to the store-wide remembered counter. */
  bumpRemembered(count: number): Promise<void>;
}
