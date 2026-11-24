import {
  type Actor,
  authCreate as authCreateIn,
  type AuthCreateOptions,
  type AuthCreateResult,
  authCreateSelf as authCreateSelfIn,
  type AuthCreateSelfOptions,
  type AuthCreateSelfResult,
  authRevoke as authRevokeIn,
  type AuthRevokeResult,
  type EntryContext as Context,
} from './api/index.js';
import { withEntryInfra } from './surface/entry-infra.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from './base/errors/api-errors.js';

/** Mints a key stamped by the caller's clock, else the host's. */
export function authCreate(ctx: Context, opts: AuthCreateOptions): Promise<AuthCreateResult> {
  return authCreateIn(withEntryInfra(ctx), opts);
}

/** Mints the signed-in caller's own key, stamped by the caller's clock, else the host's. */
export function authCreateSelf(
  ctx: Context,
  opts: AuthCreateSelfOptions,
): Promise<AuthCreateSelfResult> {
  return authCreateSelfIn(withEntryInfra(ctx), opts);
}

/** Revokes a key, stamped by the caller's clock, else the host's. */
export function authRevoke(ctx: Context, keyId: string): Promise<AuthRevokeResult> {
  return authRevokeIn(withEntryInfra(ctx), keyId);
}

export { serve } from './surface/server/boot.js';
export { embedAll } from './domain/search/embed-memories.js';
export { folderIndex } from './surface/folder-index.js';
export { promptHookContext } from './surface/server/prompt-hook-context.js';

export {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  type AuthCreateSelfOptions,
  type AuthCreateSelfResult,
  type AuthRevokeResult,
  type Context,
  type Actor,
};
export { isCrossSite, LOOPBACK_HOST_HEADER } from './surface/http/http-util.js';
export { clientIpForRateLimit } from './surface/server/client-ip.js';
export { isLoopback, isReservedActor } from './surface/server/auth.js';
export type {
  AddonCall,
  AddonRoute,
  AuthResolver,
  KeyQuota,
  KeyQuotaCall,
  KeyQuotaRefusal,
  OAuthResource,
  RateLimitSpec,
  ResolvedBearer,
  ServeOptions,
  ServerHandle,
} from './surface/server/types.js';
export {
  GROUPS_CLAIM_TOO_LONG,
  NO_MAPPED_GROUP,
  roleFromGroups,
  VIEWER_REFUSAL,
} from './base/scope/role.js';
export type { Role, RoleFromGroups, RoleGroups, RoleLevel } from './base/scope/role.js';
export { admitProjectWrite } from './api/project-write-gate.js';
export type { ProjectWriteCall, ProjectWriteGate } from './api/types.js';
export type { HippoStore } from './base/ports/store-index.js';
export type { DetachedWork } from './domain/search/detached-work.js';
export { HttpError } from './base/errors/http-errors.js';
export type { CallerProject } from './api/prompt-hook.js';
export type { JsonValue } from './base/util/json.js';
export {
  captureSessionTexts,
  type CaptureContext,
  type SessionCaptureRequest,
  type SessionCaptureResult,
} from './surface/capture/session-texts.js';
export type { AuthCreateOptions, AuthCreateResult };
export { ownerOrSubject } from './api/index.js';
export { bindSessionOwner } from './api/auth/session-owners.js';
export {
  preCompactForCaller,
  type CallerHookOutput,
  type CallerPreCompactRequest,
} from './surface/capture/pre-compact-caller.js';
export {
  compactResumeForCaller,
  type CallerCompactResumeRequest,
} from './surface/capture/compact-resume-caller.js';
export {
  saveCompactionItemsForCaller,
  type CallerItemsRequest,
  type CallerItemsResult,
} from './surface/capture/compaction-items-caller.js';
export {
  captureFailureForCaller,
  type CallerFailureRequest,
  type CallerFailureResult,
} from './surface/capture/failure-caller.js';
export {
  sessionEndHandoffForCaller,
  type CallerEvidence,
  type CallerSessionEndRequest,
  type CallerSessionEndResult,
} from './surface/capture/session-end-caller.js';
export type { WorkingState } from './base/session/working-state.js';
