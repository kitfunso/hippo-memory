// The root entry's learning loop: lessons from errors, the share score and global store, and the feature eval suite.
export { captureError, extractLessons, partitionLessons } from '../domain/learn/autolearn.js';
export { getGlobalRoot } from '../domain/sharing/global-store.js';
export { transferScore } from '../domain/sharing/share.js';
export {
  runFeatureEval,
  formatResult,
  resultToBaseline,
  detectRegressions,
  buildSyntheticCorpus,
} from '../domain/eval/eval-suite.js';
