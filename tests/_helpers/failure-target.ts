import type { FailureTarget } from '../../src/surface/capture/capture-error.js';
import { sqliteStore } from './test-session.js';
import { loadConfig } from '../../src/host/config-file.js';
import { evalNow } from '../../src/infra/eval-switches.js';

export const failureTarget = (hippoRoot: string, tenantId = 'default'): FailureTarget => ({
  tenantId,
  store: sqliteStore(hippoRoot),
  config: loadConfig(hippoRoot),
  infra: { clock: evalNow },
});
