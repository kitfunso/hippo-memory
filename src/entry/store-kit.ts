export type { ApiKeyListItem, ApiKeyListRow, ListApiKeysOpts, NewApiKey } from '../store/port/keys.js';
export type {
  ApiKeyRecord,
  AppendAuditOpts,
  AuditEvent,
  ActiveGoals,
  GetActiveGoalsOpts,
  Goal,
  RetrievalPolicy,
  ClassResolution,
  PlanningFallacyEvidence,
  PredictionBaserate,
  OriginFilter,
  ContinuityKey,
  DormantSnapshot,
  EntryCursor,
  EntryPage,
} from '../store/port/types.js';
export type { GoalRecallLogRow, RecallTraceInput, StrengthenOptions } from '../store/port/recall-writes.js';
export type { RecallScopeFilter, VectorCandidateSpec, EmbeddingIndexState } from '../store/port/vectors.js';
export type {
  RawRefRow,
  AmbientCandidates,
  AmbientLoadResult,
  AmbientRefusal,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
  AmbientStoreFilter,
} from '../store/port/context-reads.js';
export type {
  FailureEvent,
  FailureOutcome,
  RejectedValueRow,
  FailureSummary,
  AppliedRejection,
  LiftedRejection,
  Rejection,
  RejectionSource,
} from '../store/port/rejections.js';

// The hippo-memory/store-kit subpath: the contract for a second HippoStore (port types, row types, hippo.db's rule
// helpers), so a store built on it applies hippo.db's rules with the same code.

// An add-on serves from another database by passing serve() its own HippoStore.
export {
  sqliteStore,
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
  OTHER_STORE_MARKER,
} from '../surface/open-store.js';
// The second supported store: every required group held in memory; CI runs the server and MCP suites on it.
export { memoryStore } from '../store/memory/store.js';
export type { MemoryTables } from '../store/memory/tables.js';
export {
  hasGroup,
  requireGroup,
  type AmbientCandidateRequest,
  type CallerItemsSaved,
  type CardCreate,
  type Cards,
  type Compactions,
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
export { entryAfterOutcome } from '../base/memory/memory.js';
export { normalizeValueForRejection, rejectionDigest } from '../base/records/rejection-digest.js';
// An add-on's rejections find the texts a sleep-merged row holds with hippo.db's rule.
export { heldTexts } from '../base/util/same-text.js';
// An add-on's quality repair keeps the rows hippo.db's does.
export { PROTECTED_ROWS, repairKeeps, type RepairProtection } from '../base/memory/memory-audit.js';
export { RejectedValueError } from '../base/errors/api-errors.js';
export {
  ownScopeTouches,
  readerReaches,
  targetReader,
  type ScopeReader,
  passesScopeFilterForRecall,
  RECALL_DEFAULT_DENY_SCOPES,
} from '../base/scope/recall-scope.js';
export type { KeysetPosition } from '../base/util/keyset.js';
// The types HippoStore's methods take and return, so an add-on store can implement them from this subpath.
export type { ContinuityBlock } from '../api/recall/types.js';
export type { MemoryEntry } from '../base/memory/memory.js';
export type {
  SessionEvent,
  TaskSnapshot,
  HandoffFilter,
  SessionEndHandoffRequest,
  SessionEventInput,
  SnapshotInput,
  WorkingMemoryItem,
} from '../store/port/sessions.js';
export type { HandoffOutcome, SessionHandoff } from '../base/session/handoff.js';
// The types the Sessions, Cards, Goals, Conflicts, Dormant and Reports groups take and return.
export type { Card, CardComment, CardRun, CardStatus } from '../base/records/card.js';
export type { CardDetail } from '../store/port/cards.js';
export type { CompleteGoalOpts, PushGoalOpts } from '../store/port/goals.js';
export type {
  ConflictListQuery,
  ConflictMember,
  ConflictResolution,
  ConflictRow,
  ConflictRowPage,
  ConflictSide,
  LoserFate,
  MemoryConflict,
} from '../store/port/conflicts.js';
export type { DormantMemory, DormantRestoreOutcome, ListDormantOpts } from '../store/port/dormant.js';
export type { CallerItems, CompactionStart } from '../store/port/capture.js';
export type {
  CorrectionLink,
  RawProvenance,
  StatusCounts,
  StrengthTallies,
  LegacyStats,
} from '../store/port/reports.js';
export type { TokenSummary, TokenUse } from '../store/port/ledger.js';
export type { AmbientTallies } from '../base/memory/ambient.js';
export type { PhysicsParticle } from '../base/rank/physics.js';
// An add-on ranks its own particles by physics with hippo.db's code, by passing its store and root in the options.
export { physicsSearch } from './folder-search.js';
export { StoreBusyError } from '../store/port.js';
// A port method that can read every tenant takes ALL_TENANTS there, so an add-on store tells it from a missed tenant.
export { ALL_TENANTS, type TenantId } from '../base/util/tenant.js';
// An add-on store encodes, decodes and ranks vectors and particles with hippo.db's own code, and drops the index by its
// rule, so both stores keep the same bytes and return the same ids in the same order.
export { bufferToFloat32, float32ToBuffer } from '../base/util/vector-codec.js';
export { replacesIndex } from '../base/embeddings/index-identity.js';
// An add-on's ContextReads applies hippo.db's scope, secret, tally and rarest-term rules with the same code.
// An add-on's ambientCandidates and summaryWithDescendants admit rows by hippo.db's rule.
export {
  ambientRefusal,
  descendantAdmits,
  type AmbientAdmission,
  type AmbientRefusalReason,
  type DescendantAdmission,
} from '../base/scope/read-admission.js';
export { SECRET_TAGS } from '../base/util/secret-detect.js';
export { tallyAmbientEntries } from '../base/memory/ambient.js';
// An add-on's graphReads.graphDelta plans the rebuild's ops from its stored rows by hippo.db's rule.
export { diffGraph, type StoredGraph } from '../store/rules/graph-delta.js';
export { ftsTermParts, rarestFtsQuery } from '../base/rank/prompt-recall.js';
// store copy --db writes the marker into the other store's folder.
// An add-on that serves a team store checks the flag before it starts.
export { isSharedStore, loadConfig, type HippoConfig } from '../base/config/config.js';
// A Context carries its store's config, so an integrator that builds one loads it here.
