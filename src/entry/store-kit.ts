import { RECALL_ONLY_TAGS as recallOnlyTags, type MemoryEntry } from '../base/memory/entry.js';
import { entryAfterOutcome as outcomeAt } from '../base/memory/keep-rules.js';
import { PRODUCTION_STRENGTH, withLossAversion } from '../base/memory/strength.js';
import {
  tallyAmbientEntries as tallyAmbientAt,
  type AmbientTallies,
} from '../base/memory/ambient.js';
import { evalNow, evalSwitches } from '../infra/eval-switches.js';
export type {
  ApiKeyListItem,
  ApiKeyListRow,
  ListApiKeysOptions,
  NewApiKey,
} from '../base/ports/store/keys.js';
export type {
  ApiKeyRecord,
  AppendAuditOptions,
  AuditEvent,
  ActiveGoals,
  GetActiveGoalsOptions,
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
} from '../base/ports/store/types.js';
export type {
  GoalRecallLogRow,
  RecallTraceInput,
  StrengthenOptions,
} from '../base/ports/store/recall-writes.js';
export type {
  RecallScopeFilter,
  VectorCandidateSpec,
  EmbeddingIndexState,
  StoredPart,
  StoredParts,
} from '../base/ports/store/vectors.js';
export type {
  AmbientCandidates,
  AmbientLoadResult,
  AmbientRefusal,
  AmbientRecallRequest,
  ContextCandidateFilter,
  RecentOrigins,
  AmbientStoreFilter,
} from '../base/ports/store/context-reads.js';
export type {
  FailureEvent,
  FailureOutcome,
  RejectedValueRow,
  FailureSummary,
  AppliedRejection,
  LiftedRejection,
  Rejection,
  RejectionSource,
} from '../base/ports/store/rejections.js';

export {
  publishedDefaultStore as sqliteStore,
  publishedInitStore as initStore,
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
  OTHER_STORE_MARKER,
} from '../surface/open-store.js';
export { runStoreConformance, type ConformanceRunner } from './store-conformance.js';
export {
  hasGroup,
  OPTIONAL_GROUPS,
  requireGroup,
  type RequiredStore,
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
} from '../base/ports/store-index.js';
/** `entry` after one good or bad outcome, scored at `rules.now` (default: the eval clock), so a
 * second store with its own clock scores as hippo.db does. */
export function entryAfterOutcome(
  entry: MemoryEntry,
  good: boolean,
  rules: { lossAversionRatio?: number; now?: Date } = {},
): MemoryEntry {
  return outcomeAt(
    entry,
    good,
    rules.now ?? evalNow(),
    withLossAversion(PRODUCTION_STRENGTH, rules.lossAversionRatio),
  );
}
export {
  normalizeValueForRejection,
  rejectionDigest,
  rowDigests,
  tombstoneDigest,
} from '../base/records/rejection-digest.js';
export { duplicateHash, heldTexts, identityText } from '../base/util/same-text.js';
export { isoInstant, sortableStamp } from '../base/memory/created-stamp.js';
export { cjkIndexTerms, partitionCjkTerms } from '../base/util/tokenize.js';
export { interleaveRows } from '../base/util/interleave.js';
export { splitLikeTerms } from '../store/rules/like-terms.js';
export {
  LIKE_WINDOW_ROWS,
  LIKE_WINDOW_TERMS,
  SCHEMA_FIT_WINDOW_ROWS,
} from '../store/rules/windows.js';
export { auditRowsRead } from '../base/ports/store/audit.js';
export { RawAppendOnlyError } from '../base/errors/raw-append-only.js';
/** The tags that keep an unpinned row out of ambient context; a list, so a new tag changes no
 * public type. */
export const RECALL_ONLY_TAGS: readonly string[] = Object.freeze([...recallOnlyTags]);
export { PROTECTED_ROWS, repairKeeps, type RepairProtection } from '../base/memory/memory-audit.js';
export { RejectedValueError } from '../base/errors/api-errors.js';
export {
  assertWriteRight,
  canReadScope,
  ownScopeTouches,
  readerMayChange,
  readerReaches,
  targetReader,
  type ScopeActor,
  type ScopeReader,
  type WrittenRow,
  passesScopeFilterForRecall,
  RECALL_DEFAULT_DENY_SCOPES,
} from '../base/scope/recall-scope.js';
export type { KeysetPosition } from '../base/util/keyset.js';
export type { ContinuityBlock } from '../api/recall/types.js';
export type { MemoryEntry } from '../base/memory/entry.js';
export type {
  SessionEvent,
  TaskSnapshot,
  HandoffFilter,
  SessionEndHandoffRequest,
  SessionEventInput,
  SnapshotInput,
  WorkingMemoryItem,
} from '../base/ports/store/sessions.js';
export type { HandoffOutcome, SessionHandoff } from '../base/session/handoff.js';
export type { Card, CardComment, CardRun, CardStatus } from '../base/records/card.js';
export type { CardDetail } from '../base/ports/store/cards.js';
export type { CompleteGoalOptions, PushGoalOptions } from '../base/ports/store/goals.js';
export type {
  ConflictListQuery,
  ConflictMember,
  ConflictResolution,
  ConflictRow,
  ConflictRowPage,
  ConflictSide,
  LoserFate,
  MemoryConflict,
} from '../base/ports/store/conflicts.js';
export type {
  DormantMemory,
  DormantRestoreOutcome,
  ListDormantOptions,
} from '../base/ports/store/dormant.js';
export type { CallerItems, CompactionStart } from '../base/ports/store/capture.js';
export type {
  CorrectionLink,
  EntryFilter,
  PageRequest,
  RawProvenance,
  StatusCounts,
  StrengthTallies,
  LegacyStats,
} from '../base/ports/store/reports.js';
export type { TokenSummary, TokenUse } from '../base/ports/store/ledger.js';
export type { AmbientTallies } from '../base/memory/ambient.js';
export type { PhysicsParticle } from '../base/rank/physics.js';
export { physicsSearch } from './folder-search.js';
export { StoreBusyError } from '../base/ports/store.js';
export { ALL_TENANTS, type TenantId } from '../base/util/tenant.js';
export { bufferToFloat32, float32ToBuffer } from '../base/util/vector-codec.js';
export { replacesIndex } from '../base/embeddings/index-identity.js';
export {
  ambientRefusal,
  descendantAdmits,
  type AmbientAdmission,
  type AmbientRefusalReason,
  type DescendantAdmission,
} from '../base/scope/read-admission.js';
export { SECRET_TAGS } from '../base/util/secret-detect.js';
/** An add-on's ambient tallies, scored as hippo.db's are under the environment's eval switches. */
export function tallyAmbientEntries(entries: readonly MemoryEntry[], now?: Date): AmbientTallies {
  return tallyAmbientAt(entries, now ?? evalNow(), evalSwitches().strength);
}
export { diffGraph, type StoredGraph } from '../store/rules/graph-delta.js';
export { GRAPH_ID_BATCH } from '../base/ports/store/graph.js';
export { ftsTermParts, rarestFtsQuery } from '../base/rank/prompt-recall.js';
export { type HippoConfig } from '../base/config/config.js';
export { isSharedStore, loadConfig } from '../host/config-file.js';
