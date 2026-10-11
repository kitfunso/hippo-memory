// The one place the loss-aversion ratio is read from env; core takes it as a value.

import { parseLossAversionRatio, setProcessLossAversionRatio } from '../core/memory.js';
import { envLossAversionRatio } from '../util/env.js';

/** The ratio HIPPO_LOSS_AVERSION_RATIO means right now: 1.0 when unset, non-numeric or below the floor. */
export function lossAversionRatio(): number {
  return parseLossAversionRatio(envLossAversionRatio());
}

// Set at import, as the old lazy read was: every entry point loads the api barrel.
setProcessLossAversionRatio(lossAversionRatio());
