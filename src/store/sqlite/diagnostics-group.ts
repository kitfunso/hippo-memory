import { openHippoDbReadOnly } from '../../db/index.js';
import { storeHealthAt, storeInventoryAt } from '../diagnostics.js';
import type { OnHandle } from './open.js';
import type { Diagnostics } from '../port/diagnostics.js';
import { projectTagReads } from './project-tags.js';

export function sqliteDiagnostics(on: OnHandle): Diagnostics {
  return {
    health: (cutoffs) => on((db) => storeHealthAt(db, cutoffs), openHippoDbReadOnly),
    inventory: () => on(storeInventoryAt, openHippoDbReadOnly),
    projectTags: (tenantId, read) => on((db) => read(projectTagReads(db, tenantId)), openHippoDbReadOnly),
  };
}
