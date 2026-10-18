import type { FailureTarget } from '../../src/capture/capture-error.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { loadConfig } from '../../src/core/config.js';

export const failureTarget = (hippoRoot: string, tenantId = 'default'): FailureTarget => ({
  tenantId,
  store: sqliteStore(hippoRoot),
  config: loadConfig(hippoRoot),
});
