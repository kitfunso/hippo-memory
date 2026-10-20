import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { inject } from 'vitest';
import { getHippoDbPath } from '../../src/db/open.js';
import { initStore } from '../../src/store/sqlite/handles.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** hippo.db of the store tests/_store-template.ts migrated for this run. */
    storeTemplate: string;
  }
}

/** initStore on a copy of the run's migrated store: the open finds the schema current, so no migration runs. A test
 *  of migrations, of a store's first open or of an open's refusal calls initStore itself. */
export function initTestStore(hippoRoot: string): void {
  const db = getHippoDbPath(hippoRoot);
  if (!existsSync(db)) {
    mkdirSync(hippoRoot, { recursive: true, mode: 0o700 });
    copyFileSync(inject('storeTemplate'), db);
  }
  initStore(hippoRoot);
}
