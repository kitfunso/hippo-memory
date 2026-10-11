import {
  type Actor, authCreateSelf, type AuthCreateSelfOpts, type AuthCreateSelfResult, authRevoke, type AuthRevokeReply, type AuthRevokeResult, type Context,
} from './api/index.js';
import { ForbiddenError, NotFoundError } from './core/api-errors.js';

export { serve } from './server/boot.js';

// Add-on packages mint and revoke keys through these without importing the whole api surface.
export {
  authCreateSelf, authRevoke, ForbiddenError, NotFoundError,
  type AuthCreateSelfOpts, type AuthCreateSelfResult, type AuthRevokeReply, type AuthRevokeResult, type Context, type Actor,
};
// Published on the hippo-memory/server subpath before they moved to http-util.ts, so they stay exported here.
export { isCrossSite, LOOPBACK_HOST_HEADER } from './util/http-util.js';
// The code behind these lives in src/server/; this subpath keeps exporting them.
export { __resetSessionRecallHistoryHttp } from './server/routes/recall.js';
export { clientIpForRateLimit } from './server/client-ip.js';
export { isLoopback, isReservedActor } from './server/auth.js';
export type { AddonCall, AddonRoute, AuthResolver, RateLimitSpec, ResolvedBearer, ServeOpts, ServerHandle } from './server/types.js';
// What an add-on route handler needs: HttpError for its 4xx replies, promptHookContext
// for a caller that renders the prompt hook elsewhere, JsonValue for its body.
export { HttpError } from './util/http-util.js';
export { promptHookContext, type CallerProject } from './api/prompt-hook.js';
export type { JsonValue } from './util/json.js';
// A session-end route stores the turns its caller read from a transcript on the caller's own machine.
export { captureSessionTexts, type SessionCaptureRequest, type SessionCaptureResult } from './capture/session-texts.js';
// An add-on serves from another database by passing serve() its own HippoStore.
export {
  hasGroup, sqliteStore,
  type AmbientCandidateRequest, type ContextReads, type EntryRemoval, type EntryTarget, type EntryWrite, type EntryWrites, type HippoStore,
  type KeyAudit, type KeyListQuery, type KeyMint, type KeyRevoke, type KeyWrites, type OutcomeWrite, type RawArchive, type RecallSearchArgs,
  type RecallWrites, type SelfKeyMint, type StoreGroup, type StoreGroups, type SupersedeWrite, type VectorReads,
  type VectorBackfillQuery, type VectorRowWrite, type VectorWrite, type VectorWriteResult, type VectorWrites,
} from './store/index.js';
// An add-on store's entry writes apply an outcome, guard tombstones and check reach exactly as hippo.db does.
export { entryAfterOutcome } from './core/memory.js';
export { rejectionDigest } from './store/rejection.js';
export { RejectedValueError } from './core/api-errors.js';
export { ownScopeTouches } from './core/recall-scope.js';
export { BadRequestError, ConflictError } from './core/api-errors.js';
export type { HippoDbContext, StoreReply } from './api/types.js';
export type { ApiKeyListItem, ApiKeyListRow, ApiKeyRecord, ListApiKeysOpts, NewApiKey } from './store/auth.js';
export type { KeysetPosition } from './util/keyset.js';
// The types HippoStore's methods take and return, so an add-on store can implement them from this subpath.
export type { AppendAuditOpts, AuditEvent, ListAuditAfterOpts } from './store/audit.js';
export type { ContinuityBlock } from './api/recall-types.js';
export type { ActiveGoals, GetActiveGoalsOpts, Goal, GoalRecallLogRow, RetrievalPolicy } from './store/goals.js';
export type { MemoryEntry } from './core/memory.js';
export type { ClassResolution, PlanningFallacyEvidence } from './store/planning-fallacy-evidence.js';
export type { PredictionBaserate } from './store/predictions.js';
export type { RecallTraceInput } from './store/recall-trace.js';
export type { StrengthenOptions } from './store/entry-writes.js';
export type { OriginFilter, RecallScopeFilter, VectorCandidateSpec } from './store/search-rows.js';
export type { ContinuityKey } from './store/sessions.js';
export type { SessionEvent, TaskSnapshot } from './store/rows.js';
export type { SessionHandoff } from './core/handoff.js';
export type { AmbientLoadResult, AmbientRecallRequest, ContextCandidateFilter, RecentOrigins } from './store/candidates.js';
export type { AmbientStoreFilter } from './store/ambient.js';
export type { AmbientTallies } from './core/ambient.js';
export type { TokenUse } from './store/token-ledger.js';
export type { EmbeddingIndexState } from './store/vector-index.js';
export type { PhysicsParticle } from './core/physics.js';
export { StoreBusyError } from './store/port.js';
// An add-on store encodes, decodes and ranks vectors and particles with hippo.db's own code, and drops the index by its rule,
// so both stores keep the same bytes and return the same ids in the same order.
export { decodeVector, EMBEDDING_MODEL_META_KEY, encodeVector, rankVectorRows, type VectorMatch, type VectorRow } from './db/vector-store.js';
export { bufferToFloat32, float32ToBuffer } from './db/physics-state.js';
export { replacesIndex } from './store/vector-index.js';
// An add-on's ContextReads applies hippo.db's scope, secret, tally and rarest-term rules with the same code.
export { passesScopeFilterForRecall, RECALL_DEFAULT_DENY_SCOPES } from './core/recall-scope.js';
export { SECRET_TAGS } from './util/secret-detect.js';
export { tallyAmbientEntries } from './core/ambient.js';
export { ftsTermParts, rarestFtsQuery } from './core/prompt-recall.js';
// store copy --db writes the marker and reads the old hippo.db under the waiver.
export { OTHER_STORE_MARKER, OtherStoreFolderError, withSqliteAllowed } from './db/index.js';
// An add-on's install step mints the first admin key into a store folder it names, which `hippo auth create` cannot reach.
export { authCreate, type AuthCreateOpts, type AuthCreateResult } from './api/index.js';

// An add-on that serves a team store checks the flag before it starts.
export { isSharedStore } from './core/config.js';
export { ownerOrSubject } from './api/index.js';
// A route that writes for a session binds it to the caller's owner first.
export { bindSessionOwner } from './api/session-owners.js';
// A hook route for a caller on another machine: each call binds the session, then writes under the caller's owner and project.
export { preCompactForCaller, type CallerHookOutput, type CallerPreCompactRequest } from './capture/pre-compact-caller.js';
export { compactResumeForCaller, type CallerCompactResumeRequest } from './capture/compact-resume-caller.js';
export { saveCompactionItemsForCaller, type CallerItemsRequest, type CallerItemsResult } from './capture/compaction-items-caller.js';
export { captureFailureForCaller, type CallerFailureRequest, type CallerFailureResult } from './capture/failure-caller.js';
export { sessionEndHandoffForCaller, type CallerEvidence, type CallerSessionEndRequest, type CallerSessionEndResult } from './capture/session-end-caller.js';
export type { WorkingState } from './capture/working-state.js';
