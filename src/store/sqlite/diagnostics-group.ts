import { openHippoDbReadOnly } from '../../db/index.js';
import { storeHealthAt, storeInventoryAt } from '../diagnostics.js';
import { onHandle } from '../open.js';
import type { Diagnostics } from '../port/diagnostics.js';
import { projectTagReads } from '../project-tags.js';

export function sqliteDiagnostics(hippoRoot: string): Diagnostics {
  return {
    health: (cutoffs) => onHandle(hippoRoot, (db) => storeHealthAt(db, cutoffs), openHippoDbReadOnly),
    inventory: () => onHandle(hippoRoot, storeInventoryAt, openHippoDbReadOnly),
    projectTags: (tenantId, read) =>
      onHandle(hippoRoot, (db) => read(projectTagReads(db, tenantId)), openHippoDbReadOnly),
  };
}
