import * as api from './api/index.js';
import type {
  Actor,
  AuthCreateOptions,
  AuthCreateResult,
  AuthCreateSelfOptions,
  AuthCreateSelfResult,
  AuthRevokeResult,
  EntryContext as Context,
} from './api/index.js';
import { filled } from './surface/entry-infra.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from './base/errors/api-errors.js';

/** Mints a key stamped by the caller's clock, else the host's. */
export const authCreate = filled(api.authCreate);

/** Mints the signed-in caller's own key, stamped by the caller's clock, else the host's. */
export const authCreateSelf = filled(api.authCreateSelf);

/** Revokes a key, stamped by the caller's clock, else the host's. */
export const authRevoke = filled(api.authRevoke);

export { serve } from './surface/server/boot.js';
export { promptHookContext } from './surface/server/prompt-hook-context.js';

// Add-on packages mint and revoke keys through these without importing the whole api surface.
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
  RateLimitSpec,
  ResolvedBearer,
  ServeOptions,
  ServerHandle,
} from './surface/server/types.js';
// ServeOptions takes a HippoStore; the rest of the store contract is on hippo-memory/store-kit.
export type { HippoStore } from './base/ports/store-index.js';
// What a caller sets as Context.detached to keep the embeds a call hands off.
export type { DetachedWork } from './domain/search/detached-work.js';
// An add-on route replies 4xx with HttpError, renders the prompt hook elsewhere with
// promptHookContext, and types its body as JsonValue.
export { HttpError } from './base/errors/http-errors.js';
export type { CallerProject } from './api/prompt-hook.js';
export type { JsonValue } from './base/util/json.js';
// A session-end route stores the turns its caller read from a transcript on the caller's own
// machine; a store without hippo.db's local tier rejects.
export {
  captureSessionTexts,
  type SessionCaptureRequest,
  type SessionCaptureResult,
} from './surface/capture/session-texts.js';
// An add-on's install step mints the first admin key into a store folder it names, which `hippo
// auth create` cannot reach.
export type { AuthCreateOptions, AuthCreateResult };
export { ownerOrSubject } from './api/index.js';
// A route that writes for a session binds it to the caller's owner first.
export { bindSessionOwner } from './api/hippo-db/session-owners.js';
// A hook route for a caller on another machine: each call binds the session, then writes under the
// caller's owner and project.
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
} from './surface/capture/session-end-caller.js';
export type { CallerSessionEndResult } from './api/session-end.js';
export type { WorkingState } from './base/session/working-state.js';
