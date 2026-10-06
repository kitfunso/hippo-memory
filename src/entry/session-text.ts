// The hippo-memory/session-text subpath: what a hook reads from a session (turns, working state, failures, git state, compaction items) and the sharing scrub, with no store, database or server in its imports.
export { collectSessionTurns, sessionTail, type SessionTurn } from '../capture/transcript.js';
export { scrubForSharing } from '../share-scrub.js';
export { transcriptWorkingState, WORKING_STATE_CAPS } from '../capture/working-state.js';
export { lessonFromFailure, failureReport, type FailureReport } from '../capture/failure-reading.js';
export { collectHandoffEvidence } from '../handoff-evidence.js';
export { compactSummaryBody, parseCompactionItems, COMPACTION_ITEM_MAX_CHARS, COMPACTION_ITEM_ROW_CAP } from '../compaction-items.js';
