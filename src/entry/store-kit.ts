import type { MemoryEntry } from '../base/memory/entry.js';
import { entryAfterOutcome as outcomeAt } from '../base/memory/keep-rules.js';
import { PRODUCTION_STRENGTH, withLossAversion } from '../base/memory/strength.js';
import {
  tallyAmbientEntries as tallyAmbientAt,
  type AmbientTallies,
} from '../base/memory/ambient.js';
import { evalNow, evalSwitches } from '../infra/eval-switches.js';
import type { StoreRules } from '../base/ports/infra.js';
import type { HippoStore } from '../base/ports/store-index.js';
import * as openStore from '../surface/open-store.js';
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
} from '../base/records/rejections.js';

// The hippo-memory/store-kit subpath: the core port, row types and hippo.db's rule helpers for a second HippoStore.
// Its one known user, hippo-enterprise's Postgres store (pgStore in src/pg/store/pg-store.ts), pins hippo-memory
// ^1.69.0 and must port to this 3.0 core port before it can take 3.0.

/** hippo.db's store, which an add-on swaps for its own HippoStore in serve(); it takes only an
 * add-on's rules. Typed as the core port: hippo.db's local tier is not part of the contract. */
export const sqliteStore: (hippoRoot: string, rules?: StoreRules) => HippoStore =
  openStore.sqliteStore;
export {
  decodeVector,
  EMBEDDING_MODEL_META_KEY,
  encodeVector,
  rankVectorRows,
  type VectorMatch,
  type VectorRow,
  OTHER_STORE_MARKER,
} from '../surface/open-store.js';
export { runStoreConformance } from './store-conformance.js';
export type { ConformanceRunner } from './conformance/kit.js';
export type {
  AmbientCandidateRequest,
  ContextReads,
  EntryRemoval,
  EntryTarget,
  EntryWrite,
  EntryWrites,
  HippoStore,
  KeyListQuery,
  KeyMint,
  KeyRevoke,
  KeyWrites,
  OutcomeWrite,
  RawArchive,
  RecallSearchArgs,
  RecallWrites,
  SelfKeyMint,
  CoreGroups,
  SupersedeWrite,
  VectorReads,
  VectorBackfillQuery,
  VectorRowWrite,
  VectorWrite,
  VectorWriteResult,
  VectorWrites,
} from '../base/ports/store-index.js';
export type { CallerItemsSaved, Compactions } from '../base/records/capture.js';
export type { CardCreate, Cards } from '../base/records/cards.js';
export type { Conflicts } from '../base/records/conflicts.js';
export type { Dormant, DormantRestoreRequest } from '../base/records/dormant.js';
export type { FailureLog, RejectionCheck, Rejections } from '../base/records/rejections.js';
export type { Goals } from '../base/records/goals.js';
export type { LastRecall, LastRecallWrites } from '../base/records/last-recall.js';
export type { Reports } from '../base/records/reports.js';
export type { Sessions, WorkingMemoryFilter, WorkingMemoryPush } from '../base/records/sessions.js';
// An add-on store's entry writes apply an outcome, guard tombstones and check reach exactly as
// hippo.db does.
export function entryAfterOutcome(
  entry: MemoryEntry,
  good: boolean,
  rules: { lossAversionRatio?: number } = {},
): MemoryEntry {
  return outcomeAt(
    entry,
    good,
    evalNow(),
    withLossAversion(PRODUCTION_STRENGTH, rules.lossAversionRatio),
  );
}
export { normalizeValueForRejection, rejectionDigest } from '../base/records/rejection-digest.js';
// An add-on's rejections find the texts a sleep-merged row holds with hippo.db's rule.
export { heldTexts } from '../base/util/same-text.js';
// An add-on's quality repair keeps the rows hippo.db's does.
export { PROTECTED_ROWS, repairKeeps, type RepairProtection } from '../base/memory/memory-audit.js';
export { RejectedValueError } from '../base/errors/api-errors.js';
export {
  assertWriteRight,
  ownScopeTouches,
  readerMayChange,
  readerReaches,
  targetReader,
  type ScopeReader,
  type WrittenRow,
  passesScopeFilterForRecall,
  RECALL_DEFAULT_DENY_SCOPES,
} from '../base/scope/recall-scope.js';
export type { KeysetPosition } from '../base/util/keyset.js';
// The types HippoStore's methods take and return, so an add-on store can implement them from this
// subpath.
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
} from '../base/records/sessions.js';
export type { HandoffOutcome, SessionHandoff } from '../base/session/handoff.js';
// The types hippo.db's Sessions, Cards, Goals, Conflicts, Dormant and Reports repositories take and return.
export type { Card, CardComment, CardRun, CardStatus } from '../base/records/card.js';
export type { CardDetail } from '../base/records/cards.js';
export type { CompleteGoalOptions, PushGoalOptions } from '../base/records/goals.js';
export type {
  ConflictListQuery,
  ConflictMember,
  ConflictResolution,
  ConflictRow,
  ConflictRowPage,
  ConflictSide,
  LoserFate,
  MemoryConflict,
} from '../base/records/conflicts.js';
export type {
  DormantMemory,
  DormantRestoreOutcome,
  ListDormantOptions,
} from '../base/records/dormant.js';
export type { CallerItems, CompactionStart } from '../base/records/capture.js';
export type {
  CorrectionLink,
  EntryFilter,
  PageRequest,
  RawProvenance,
  StatusCounts,
  StrengthTallies,
  LegacyStats,
} from '../base/records/reports.js';
export type { TokenSummary, TokenUse } from '../base/records/ledger.js';
export type { AmbientTallies } from '../base/memory/ambient.js';
export { StoreBusyError } from '../base/ports/store.js';
// A port method that can read every tenant takes ALL_TENANTS there, so an add-on store tells it
// from a missed tenant.
export { ALL_TENANTS, type TenantId } from '../base/util/tenant.js';
// An add-on store encodes, decodes and ranks vectors with hippo.db's own code, and
// drops the index by its rule, so an add-on store and hippo.db keep the same bytes and return the
// same ids in the same order.
export { bufferToFloat32, float32ToBuffer } from '../base/util/vector-codec.js';
export { replacesIndex } from '../base/embeddings/index-identity.js';
// An add-on's ContextReads applies hippo.db's scope, secret, tally and rarest-term rules with the
// same code. An add-on's ambientCandidates and summaryWithDescendants admit rows by hippo.db's
// rule.
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
// An add-on's graphReads.graphDelta plans the rebuild's ops from its stored rows by hippo.db's
// rule.
export { diffGraph, type StoredGraph } from '../store/rules/graph-delta.js';
export { ftsTermParts, rarestFtsQuery } from '../base/rank/prompt-recall.js';
// store copy --db writes the marker into the other store's folder.
// An add-on that serves a team store checks the flag before it starts.
export { type HippoConfig } from '../base/config/config.js';
export { isSharedStore, loadConfig } from '../host/config-file.js';
// A Context carries its store's config, so an integrator that builds one loads it here.
