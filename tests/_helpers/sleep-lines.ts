import type { SleepEvent } from '../../src/api/sleep/sleep-run.js';
import { sleepEventLines } from '../../src/surface/render/sleep-events.js';

/** The lines `hippo sleep` prints under Details for a result's events. */
export function detailLines(result: { readonly events?: readonly SleepEvent[]; readonly dryRun: boolean }): string[] {
  return sleepEventLines(result.events ?? [], result.dryRun);
}
