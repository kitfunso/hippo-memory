// The retrieval eval kit `hippo eval` runs: score a corpus against the store, bootstrap one from the store's rows, run
// the built-in feature suite and compare against a saved baseline. The store's rows come from memoryList.

export { bootstrapCorpus, compareSummaries, runEval, type EvalCase, type EvalSummary } from '../domain/eval/eval.js';
export {
  detectRegressions,
  formatResult,
  resultToBaseline,
  runFeatureEval,
  type EvalBaseline,
} from '../domain/eval/eval-suite.js';
