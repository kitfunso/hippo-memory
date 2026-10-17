// Domain API layer: Context-taking functions that the CLI, the HTTP server and MCP all call, so the
// business logic lives in one place. The code lives in src/api/, one module per domain; this barrel
// keeps every import path that callers already use.

export { ApiError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../core/api-errors.js';

// The recall-side scope predicates live in recall-scope.ts (leaf) so shared.ts can use them without an import cycle.
export { isPrivateScope, passesScopeFilterForRecall } from '../core/recall-scope.js';
export { passesCliRecallScopeFilter, ScopeForbiddenError } from '../core/recall-scope.js';
export type { TokenSummary, TokenSurface, TokenSurfaceSummary } from '../store/token-ledger.js';
export type { FailureSummary } from '../store/failure-log.js';

// classifyOriginProject lives in project-identity.ts (leaf) for the same reason.
export { classifyOriginProject } from '../core/project-identity.js';

export { RecallContractError, adminActor, ownerOrSubject, requireHostAdmin } from './types.js';
export type { Actor, Context, StoreContext } from './types.js';
export { remember } from './memories/remember.js';
export type { RememberLocal, RememberOptions, RememberResult } from './memories/remember.js';
export { extractRememberedFacts, rememberLocally } from './memories/remember-local.js';
export type {
  FactExtraction,
  FactExtractionRequest,
  LocalRememberInput,
  LocalRememberOutcome,
  StartedWeak,
} from './memories/remember-local.js';
export type {
  CliCoreInspection,
  CliCoreRanker,
  CliCoreRecall,
  ContinuityBlock,
  RecallBoostOptions,
  RecallFilterOptions,
  RecallHintOptions,
  RecallOptions,
  RecallResult,
  RecallResultItem,
  RecallSuppressionSummary,
  RecallTraceOptions,
  RecallWindowOptions,
  ShownCliCore,
  ShownRanking,
  StoreRanking,
} from './recall/types.js';
export { retrieve } from './recall/recall.js';
export { DEFAULT_ASSEMBLE_BUDGET, assemble } from './assemble.js';
export type { AssembleCost, AssembleOptions, AssembleResult, AssembledContextItem } from './assemble.js';
export { drillDown } from './objects/drill-down.js';
export type {
  DrillDownChild,
  DrillDownCost,
  DrillDownFailure,
  DrillDownOptions,
  DrillDownOutcome,
  DrillDownResult,
  DrillDownSummary,
} from './objects/drill-down.js';
export { outcome, outcomeForLastRecall } from './memories/outcome.js';
export type { OutcomeForLastRecallResult, OutcomeResult } from './memories/outcome.js';
export { forget, reject, rejectOnHost, unreject } from './memories/forget.js';
export type { ForgetResult, RejectOptions, RejectResult } from './memories/forget.js';
export { listConflicts, listOpenConflicts, resolveMemoryConflict } from './memories/conflicts.js';
export type { ResolveMemoryConflictOptions, ResolveMemoryConflictResult } from './memories/conflicts.js';
export { listProjectNames, mergeProjectNames, repairProjectNames, repairProjectNamesOnce } from './objects/projects.js';
export type {
  MergeProjectNamesOptions,
  MergeResult,
  ProjectCollision,
  ProjectFold,
  ProjectSummary,
  RepairResult,
} from './objects/projects.js';
export { archiveRaw, promote, supersede } from './memories/promote.js';
export type {
  ArchiveRawOptions,
  ArchiveRawResult,
  PromoteResult,
  SupersedeOverrides,
  SupersedeResult,
} from './memories/promote.js';
export {
  DEFAULT_KEY_TTL_DAYS,
  MAX_TTL_DAYS,
  authCreate,
  authCreateSelf,
  authGrant,
  authKeyTenant,
  authListAllTenants,
  authListRows,
  authRevoke,
  authUngrant,
} from './auth/auth.js';
export type {
  AuthCreateOpts,
  AuthCreateResult,
  AuthCreateSelfOpts,
  AuthCreateSelfResult,
  AuthGrantResult,
  AuthRevokeResult,
} from './auth/auth.js';
export {
  auditList,
  auditMemoryQuality,
  computeCutoff,
  pruneAuditLog,
  removeAuditErrors,
  repairMemoryQuality,
  repairMemoryQualityOnce,
} from './auth/audit.js';
export type { AuditListOptions, AuditPass, PruneAuditOptions, PruneAuditResult } from './auth/audit.js';
export type { ContextCost, ContextOptions, ContextResult, ContextResultEntry } from './context-types.js';
export { DEFAULT_CONTEXT_BUDGET, NO_QUERY, getContext, oneCopyPerMemory } from './context.js';
export { failureSummary, recordTokens, tokenSummary } from './tokens.js';
export { forgetDormant, isDormant, listDormant, restoreDormant } from './sleep/dormant.js';
export { quarantineApprove, quarantineList, quarantineReject } from './auth/quarantine.js';
export type { QuarantineListItem } from './auth/quarantine.js';
export { sleep } from './sleep/sleep.js';
export type { SleepOpts, SleepResult } from './sleep/sleep.js';
export { goalComplete, goalList, goalPush, goalResume, goalSuspend } from './objects/goals.js';
export type { GoalPushOptions } from './objects/goals.js';
export { CLI_LEARN, MCP_LEARN, invalidateMemories, learn } from './sleep/learn.js';
export type {
  InvalidationOptions,
  InvalidationResult,
  InvalidationTarget,
  LearnOptions,
  LearnProfile,
  LearnResult,
} from './sleep/learn.js';
export { REFINED_TAG, storeRefinement } from './memories/refine.js';
