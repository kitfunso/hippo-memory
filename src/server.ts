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
import type { ConnectorEntryContext as ConnectorCommandContext } from './surface/cli/connector-source.js';
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

/** Runs one `slack` or `github` CLI verb on ctx's store and tenant, with the CLI's flags, help,
 * output and exit codes, and resolves to that exit code. `argv` omits the program name, as
 * `['github', 'dlq', 'replay', '12', '--force']`. Output goes to the process console. A store
 * without the connector groups rejects with StoreNotPortedError. ctx takes no actor: each verb
 * acts as its own CLI admin actor, so audit rows read the same on every store. A write starts
 * auto-sleep only when `ctx.callers` carries an auto-sleep host. Any other command prints a
 * message and resolves to 1. */
export async function runConnectorCommand(
  ctx: ConnectorCommandContext,
  argv: readonly string[],
): Promise<number> {
  return (await import('./cli.js')).runConnectorCommandIn(withEntryInfra(ctx), argv);
}

export type { ConnectorCommandContext };

export { serve } from './surface/server/boot.js';
// A worker process embeds the store's memories: folderIndex builds the target embedAll takes.
export { embedAll } from './domain/search/embed-memories.js';
export { folderIndex } from './surface/folder-index.js';
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
// machine; it narrows its Context with store-kit's hasGroup(ctx.store, 'captures') first.
export {
  captureSessionTexts,
  type CaptureContext,
  type SessionCaptureRequest,
  type SessionCaptureResult,
} from './surface/capture/session-texts.js';
// An add-on's install step mints the first admin key into a store folder it names, which `hippo
// auth create` cannot reach.
export type { AuthCreateOptions, AuthCreateResult };
export { ownerOrSubject } from './api/index.js';
// A route that writes for a session binds it to the caller's owner first.
export { bindSessionOwner } from './api/auth/session-owners.js';
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
  type CallerSessionEndResult,
} from './surface/capture/session-end-caller.js';
export type { WorkingState } from './base/session/working-state.js';
