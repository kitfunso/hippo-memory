// The api internals the recall CLI reads; off api/index.ts because server.ts publishes names from that barrel.

export { hashQueryText } from './recall/finish.js';
export { sessionRing, shownRecallRows } from './recall/finish.js';
export {
  availabilityPool,
  cutoffClauses,
  detectRecallHints,
  shrinkToFit,
  suppressionSummary,
  tokenPurse,
} from './recall/render.js';
export { handoffText, printedTokens, sessionTrailText, settleTokens, snapshotText } from './context-render.js';
export type {
  RankRecallResult,
  RankStage,
  RecallGraphHops,
  RecallGraphStream,
  RecallReranker,
} from './recall/pipeline.js';
