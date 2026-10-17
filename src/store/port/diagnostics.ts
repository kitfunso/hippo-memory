// What `hippo doctor` and `hippo support-bundle` read from hippo.db's own files: synchronous and read-only, so a
// check never creates, migrates or locks the store it inspects.
import type { HealthCutoffs, StoreHealth, StoreInventory } from '../diagnostics.js';
import type { ProjectTagReads } from '../project-tags.js';

export interface Diagnostics {
  /** Throws when the store cannot be opened or its schema version read. */
  health(cutoffs: HealthCutoffs): StoreHealth;
  /** Schema version, oldest allowed binary and row count of every table; never reads a memory column. */
  inventory(): StoreInventory;
  /** `read` runs on the tenant's project-tag rows, whose reads end when it returns. */
  projectTags<T>(tenantId: string, read: (reads: ProjectTagReads) => T): T;
}
