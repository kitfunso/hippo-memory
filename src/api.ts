// Domain API layer: Context-taking functions that the CLI, the HTTP server and MCP all call, so the
// business logic lives in one place. The code lives in src/api/, one module per domain; this barrel
// keeps every import path that callers already use.

export { ApiError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './api-errors.js';

// The recall-side scope predicates live in recall-scope.ts (leaf) so shared.ts can use them without an import cycle.
export { isPrivateScope, passesScopeFilterForRecall } from './recall-scope.js';
export { passesCliRecallScopeFilter, ScopeForbiddenError } from './recall-scope.js';
export type { TokenSummary, TokenSurface, TokenSurfaceSummary } from './token-ledger.js';
export type { FailureSummary } from './failure-log.js';

// classifyOriginProject lives in project-identity.ts (leaf) for the same reason.
export { classifyOriginProject } from './project-identity.js';

export * from './api/types.js';
export * from './api/remember.js';
export * from './api/recall-types.js';
export * from './api/recall.js';
export * from './api/assemble.js';
export * from './api/drill-down.js';
export * from './api/outcome.js';
export * from './api/forget.js';
export * from './api/promote.js';
export * from './api/auth.js';
export * from './api/audit.js';
export * from './api/context-types.js';
export * from './api/context.js';
export * from './api/tokens.js';
export * from './api/dormant.js';
export * from './api/quarantine.js';
export * from './api/sleep.js';
