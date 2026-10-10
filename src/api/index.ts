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

export * from './types.js';
export * from './remember.js';
export * from './remember-local.js';
export * from './recall-types.js';
export * from './recall.js';
export * from './assemble.js';
export * from './drill-down.js';
export * from './outcome.js';
export * from './forget.js';
export * from './conflicts.js';
export * from './promote.js';
export * from './auth.js';
export * from './audit.js';
export * from './context-types.js';
export * from './context.js';
export * from './tokens.js';
export * from './dormant.js';
export * from './quarantine.js';
export * from './sleep.js';
export * from './goals.js';
export * from './learn.js';
export * from './refine.js';
