// The hippo-memory/session-text subpath: what a hook reads from a session (turns, working state, failures, git state,
// compaction items) and the sharing scrub, with no store, database or server in its imports.
export { collectSessionTurns, sessionTail, type SessionTurn } from '../surface/capture/transcript.js';
export { scrubForSharing } from '../surface/capture/share-scrub.js';
export { transcriptWorkingState, WORKING_STATE_CAPS } from '../surface/capture/working-state.js';
export { lessonFromFailure, failureReport, type FailureReport } from '../surface/capture/failure-reading.js';
export { collectHandoffEvidence } from '../surface/capture/handoff-evidence.js';
export {
  compactSummaryBody,
  parseCompactionItems,
  COMPACTION_ITEM_MAX_CHARS,
  COMPACTION_ITEM_ROW_CAP,
} from '../base/util/compaction-items.js';
