// The hippo-memory/store-kit subpath: the contract for a second HippoStore (port types, row types, hippo.db's rule
// helpers),
// so a store built on it applies hippo.db's rules with the same code.

// An add-on serves from another database by passing serve() its own HippoStore.
export {
  hasGroup,
  requireGroup,
  sqliteStore,
  type AmbientCandidateRequest,
  type CardCreate,
  type Cards,
  type Conflicts,
  type ContextReads,
  type Dormant,
  type DormantRestoreRequest,
  type EntryRemoval,
  type EntryTarget,
  type EntryWrite,
  type EntryWrites,
  type FailureLog,
  type Goals,
  type HippoStore,
  type KeyAudit,
  type KeyListQuery,
  type KeyMint,
  type KeyRevoke,
  type KeyWrites,
  type LastRecall,
  type LastRecallWrites,
  type OptionalGroup,
  type OutcomeWrite,
  type RawArchive,
  type RecallSearchArgs,
  type RecallWrites,
  type RejectionCheck,
  type Rejections,
  type Reports,
  type SelfKeyMint,
  type Sessions,
  type StoreGroup,
  type StoreGroups,
  type SupersedeWrite,
  type VectorReads,
  type VectorBackfillQuery,
  type VectorRowWrite,
  type VectorWrite,
  type VectorWriteResult,
  type VectorWrites,
  type WorkingMemoryFilter,
  type WorkingMemoryPush,
} from '../store/index.js';
// An add-on store's entry writes apply an outcome, guard tombstones and check reach exactly as hippo.db does.
export { entryAfterOutcome } from '../core/memory.js';
export { normalizeValueForRejection, rejectionDigest } from '../store/rejection.js';
// An add-on's rejections find the texts a sleep-merged row holds with hippo.db's rule.
export { heldTexts } from '../util/same-text.js';
export { RejectedValueError } from '../core/api-errors.js';
export { ownScopeTouches } from '../core/recall-scope.js';
export type { ApiKeyListItem, ApiKeyListRow, ApiKeyRecord, ListApiKeysOpts, NewApiKey } from '../store/auth.js';
export type { KeysetPosition } from '../util/keyset.js';
// The types HippoStore's methods take and return, so an add-on store can implement them from this subpath.
export type { AppendAuditOpts, AuditEvent, ListAuditAfterOpts } from '../store/audit.js';
export type { ContinuityBlock } from '../api/recall/types.js';
export type { ActiveGoals, GetActiveGoalsOpts, Goal, GoalRecallLogRow, RetrievalPolicy } from '../store/goals.js';
export type { MemoryEntry } from '../core/memory.js';
export type { ClassResolution, PlanningFallacyEvidence } from '../store/planning-fallacy-evidence.js';
export type { PredictionBaserate } from '../store/predictions.js';
export type { RecallTraceInput } from '../store/recall-trace.js';
export type { StrengthenOptions } from '../store/entry-writes.js';
export type { OriginFilter, RecallScopeFilter, VectorCandidateSpec } from '../store/search-rows.js';
export type { ContinuityKey } from '../store/sessions.js';
export type { SessionEvent, TaskSnapshot } from '../store/rows.js';
export type { HandoffOutcome, SessionHandoff } from '../core/handoff.js';
// The types the Sessions, Cards, Goals, Conflicts, Dormant and Reports groups take and return.
export type { Card, CardComment, CardRun, CardStatus } from '../core/card.js';
export type { CardDetail } from '../store/card-detail.js';
export type { CompleteGoalOpts, PushGoalOpts } from '../store/goals.js';
export type { HandoffFilter, SessionEndHandoffRequest } from '../store/handoffs.js';
export type { ResolveConflictOpts, ResolveConflictRequest } from '../store/conflicts.js';
export type { DormantMemory, DormantRestoreOutcome, DormantSnapshot, ListDormantOpts } from '../store/dormant.js';
export type { EntryCursor, EntryPage } from '../store/entry-reads.js';
export type { FailureEvent, FailureOutcome, FailureSummary } from '../store/failure-log.js';
export type { MemoryConflict } from '../store/rows.js';
export type { SessionEventInput, SnapshotInput } from '../store/sessions.js';
export type { StrengthTallies } from '../store/candidates.js';
export type { TokenSummary } from '../store/token-ledger.js';
export type { WorkingMemoryItem } from '../store/working-memory.js';
export type { AppliedRejection, LiftedRejection, Rejection, RejectionSource } from '../store/rejected-values.js';
export type { RejectedValueRow } from '../store/rejection.js';
export type {
  AmbientLoadResult,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
} from '../store/candidates.js';
export type { AmbientStoreFilter } from '../store/ambient.js';
export type { AmbientTallies } from '../core/ambient.js';
export type { TokenUse } from '../store/token-ledger.js';
export type { EmbeddingIndexState } from '../store/vector-index.js';
export type { PhysicsParticle } from '../core/physics.js';
// An add-on ranks its own particles by physics with hippo.db's code, by passing its store and root in the options.
export { physicsSearch } from './folder-search.js';
export { StoreBusyError } from '../store/port.js';
// An add-on store encodes, decodes and ranks vectors and particles with hippo.db's own code, and drops the index by its
// rule,
// so both stores keep the same bytes and return the same ids in the same order.
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
} from '../db/vector-store.js';
export { bufferToFloat32, float32ToBuffer } from '../util/vector-codec.js';
export { replacesIndex } from '../store/vector-index.js';
// An add-on's ContextReads applies hippo.db's scope, secret, tally and rarest-term rules with the same code.
export { passesScopeFilterForRecall, RECALL_DEFAULT_DENY_SCOPES } from '../core/recall-scope.js';
export { SECRET_TAGS } from '../util/secret-detect.js';
export { tallyAmbientEntries } from '../core/ambient.js';
export { ftsTermParts, rarestFtsQuery } from '../core/prompt-recall.js';
// store copy --db writes the marker into the other store's folder.
export { OTHER_STORE_MARKER } from '../db/index.js';
// An add-on that serves a team store checks the flag before it starts.
export { isSharedStore } from '../core/config.js';
