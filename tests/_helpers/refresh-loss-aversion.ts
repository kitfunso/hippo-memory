import { lossAversionRatio } from '../../src/api/loss-aversion.js';
import { setProcessLossAversionRatio } from '../../src/core/memory.js';

/** Re-reads HIPPO_LOSS_AVERSION_RATIO into the process default; a test that changes the variable calls this in beforeEach and afterEach. */
export function refreshLossAversionRatio(): void {
  setProcessLossAversionRatio(lossAversionRatio());
}
