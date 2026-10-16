import {
  type Actor,
  authCreate as createKey,
  type AuthCreateOpts,
  type AuthCreateResult,
  authCreateSelf as createSelfKey,
  type AuthCreateSelfOpts,
  type AuthCreateSelfResult,
  authRevoke as revokeKey,
  type AuthRevokeResult,
  type Context,
} from './api/index.js';
import {
  promptHookContext as renderPromptHook,
  type PromptHookOpts,
  type PromptHookRequest,
} from './api/prompt-hook.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './core/api-errors.js';
import { hasGroup } from './store/port.js';
import { sqliteReach, withStoreGroups } from './store/sqlite/store.js';

export { serve } from './server/boot.js';

// An add-on hands in a Context with no store, so each entry that
// needs one fills it with hippo.db under the Context's root.
async function authCreate(ctx: Context, opts: AuthCreateOpts): Promise<AuthCreateResult> {
  return createKey(withStoreGroups(ctx, 'keyWrites'), opts);
}
async function authCreateSelf(ctx: Context, opts: AuthCreateSelfOpts): Promise<AuthCreateSelfResult> {
  return createSelfKey(withStoreGroups(ctx, 'keyWrites'), opts);
}
async function authRevoke(ctx: Context, keyId: string): Promise<AuthRevokeResult> {
  return revokeKey(withStoreGroups(ctx, 'keyAudit'), keyId);
}
async function promptHookContext(
  ctx: Context,
  req: PromptHookRequest,
  opts?: PromptHookOpts,
): ReturnType<typeof renderPromptHook> {
  const filled = withStoreGroups(ctx, 'contextReads');
  // Only hippo.db has a global store beside it; an add-on's own store reads as one project.
  const sqliteBacked = ctx.store === undefined || hasGroup(ctx.store, 'localFiles');
  const reach = ctx.reach ?? (sqliteBacked ? sqliteReach(ctx.hippoRoot, filled.store, opts?.sharedStore) : undefined);
  return renderPromptHook({ ...filled, reach }, req, opts);
}

// Add-on packages mint and revoke keys through these without importing the whole api surface.
export {
  authCreate,
  authCreateSelf,
  authRevoke,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  promptHookContext,
  type AuthCreateSelfOpts,
  type AuthCreateSelfResult,
  type AuthRevokeResult,
  type Context,
  type Actor,
};
export { isCrossSite, LOOPBACK_HOST_HEADER } from './util/http-util.js';
export { clientIpForRateLimit } from './server/client-ip.js';
export { isLoopback, isReservedActor } from './server/auth.js';
export type {
  AddonCall,
  AddonRoute,
  AuthResolver,
  RateLimitSpec,
  ResolvedBearer,
  ServeOpts,
  ServerHandle,
} from './server/types.js';
// ServeOpts takes a HippoStore; the rest of the store contract is on hippo-memory/store-kit.
export type { HippoStore } from './store/index.js';
// An add-on route replies 4xx with HttpError, renders the prompt hook elsewhere with promptHookContext, and types its
// body as JsonValue.
export { HttpError } from './util/http-util.js';
export type { CallerProject } from './api/prompt-hook.js';
export type { JsonValue } from './util/json.js';
// A session-end route stores the turns its caller read from a transcript on the caller's own machine.
export { captureSessionTexts, type SessionCaptureRequest, type SessionCaptureResult } from './capture/session-texts.js';
// An add-on's install step mints the first admin key into a
// store folder it names, which `hippo auth create` cannot reach.
export type { AuthCreateOpts, AuthCreateResult };
export { ownerOrSubject } from './api/index.js';
// A route that writes for a session binds it to the caller's owner first.
export { bindSessionOwner, bindSessionOwnerOn } from './api/auth/session-owners.js';
// A hook route for a caller on another machine: each call binds
// the session, then writes under the caller's owner and project.
export {
  preCompactForCaller,
  type CallerHookOutput,
  type CallerPreCompactRequest,
} from './capture/pre-compact-caller.js';
export { compactResumeForCaller, type CallerCompactResumeRequest } from './capture/compact-resume-caller.js';
export {
  saveCompactionItemsForCaller,
  type CallerItemsRequest,
  type CallerItemsResult,
} from './capture/compaction-items-caller.js';
export {
  captureFailureForCaller,
  type CallerFailureRequest,
  type CallerFailureResult,
} from './capture/failure-caller.js';
export {
  sessionEndHandoffForCaller,
  type CallerEvidence,
  type CallerSessionEndRequest,
  type CallerSessionEndResult,
} from './capture/session-end-caller.js';
export type { WorkingState } from './capture/working-state.js';
