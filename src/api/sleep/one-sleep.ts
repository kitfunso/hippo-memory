// One sleep per store at a time: a sleep takes the store's claim first, and one that finds it held
// does nothing, so two sleeps never extract the same memories twice.
import type { Consolidation } from '../../base/ports/store/consolidation.js';
import type { ConsolidationResult } from '../../domain/consolidate/run.js';
import type { SleepResult } from './sleep.js';
import { errorFields, errorMessage, log } from '../../base/util/log.js';

/** What an auto-sleep answers when another sleep held the store; non-null, as the sleep child's
 * reply check rejects a null result. */
export interface AutoSleepRefused {
  readonly alreadyRunning: { readonly since: string };
}

/** A sleep that did nothing: its 0 counts mean "nothing was done", not "the store is empty". */
export function refusedSleep(since: string): SleepResult {
  return {
    active: 0,
    removed: 0,
    mergedEpisodic: 0,
    newSemantic: 0,
    dryRun: false,
    alreadyRunning: { since },
  };
}

export function refusedAutoSleep(since: string): AutoSleepRefused {
  return { alreadyRunning: { since } };
}

/** What a sleep entry point answers: its result, an auto-sleep's consolidation, a refusal, or nothing. */
export type SleepAnswer = SleepResult | ConsolidationResult | AutoSleepRefused | void;

/** True for an answer a held claim produced: the one test every reader of a sleep's answer uses. */
export function sleepWasRefused(result: SleepAnswer): result is AutoSleepRefused {
  return (
    typeof result === 'object' &&
    result !== null &&
    'alreadyRunning' in result &&
    result.alreadyRunning !== undefined
  );
}

/** Runs `run` holding the store's claim; a held claim gives `refused(since)` and runs nothing. A dry
 * run writes nothing and takes no claim, and a store without claim methods runs unguarded. */
export async function oneSleepPerStore<R, F>(
  { consolidation }: { readonly consolidation: Consolidation },
  dryRun: boolean,
  run: () => Promise<R>,
  refused: (since: string) => F,
): Promise<R | F> {
  if (dryRun || consolidation.claimSleep === undefined) return run();
  const claim = await consolidation.claimSleep();
  if (claim.kind === 'held') return refused(claim.since);
  try {
    return await run();
  } finally {
    await giveBack(consolidation);
  }
}

// A failed release must not replace the sleep's own result or error; one retry, since a claim kept by a
// long-running host would refuse every later sleep until it restarts.
async function giveBack(consolidation: Consolidation): Promise<void> {
  if (consolidation.releaseSleep === undefined) return;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await consolidation.releaseSleep();
      return;
    } catch (err) {
      log.warn(
        `the sleep claim was not given back (attempt ${attempt} of 2): ${errorMessage(err)}`,
        errorFields(err),
      );
    }
  }
}
