// The `hippo-memory/eval` entry: the feature eval suite, its synthetic corpus and the regression check.
import {
  buildSyntheticCorpus as corpusAt,
  runFeatureEval as featureEvalAt,
  type EvalSuiteResult,
} from '../domain/eval/eval-suite.js';
import type { EvalSwitches } from '../base/memory/eval-switches.js';
import { evalNow, evalSwitches } from '../infra/eval-switches.js';

export { formatResult, resultToBaseline, detectRegressions } from '../domain/eval/eval-suite.js';

/** The synthetic corpus, stamped at HIPPO_FAKE_NOW or the wall clock. */
export function buildSyntheticCorpus(): ReturnType<typeof corpusAt> {
  return corpusAt(evalNow());
}

/** The feature eval under `switches`, the environment's when the caller names none, at HIPPO_FAKE_NOW or the wall
 * clock. */
export function runFeatureEval(version: string, switches: EvalSwitches = evalSwitches()): Promise<EvalSuiteResult> {
  return featureEvalAt(version, switches, evalNow());
}
