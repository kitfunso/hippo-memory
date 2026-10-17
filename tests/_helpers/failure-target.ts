import type { FailureTarget } from '../../src/capture/capture-error.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

export const failureTarget = (hippoRoot: string, tenantId = 'default'): FailureTarget =>
  ({ hippoRoot, tenantId, store: sqliteStore(hippoRoot) });
