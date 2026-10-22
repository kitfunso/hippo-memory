import {
  type Actor,
  authCreate,
  type AuthCreateOpts,
  type AuthCreateResult,
  authCreateSelf,
  type AuthCreateSelfOpts,
  type AuthCreateSelfResult,
  authRevoke,
  type AuthRevokeResult,
  type Context,
  type ContextReach,
  contextReach,
} from './api/index.js';
import { hasGroup, type HippoStore } from './store/port.js';
import {
  promptHookContext as renderPromptHook,
  type PromptHookOptions,
  type PromptHookRequest,
} from './api/prompt-hook.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from './base/errors/api-errors.js';
import { defaultReach } from './surface/open-store.js';
import { loadConfig } from './host/config-file.js';
import { resolveEmbeddingProvider } from './infra/embedding-provider.js';
import { entryHost, withEntryInfra } from './surface/entry-infra.js';

export { serve } from './surface/server/boot.js';

async function promptHookContext(
  ctx: Context,
  req: PromptHookRequest,
  opts?: PromptHookOptions,
): ReturnType<typeof renderPromptHook> {
  const reach = ctx.reach ?? (await folderReach(ctx.store, opts));
  return renderPromptHook(withEntryInfra({ ...ctx, reach }), req, opts);
}

/** The reach every root probes for a store kept in a folder, from the folder its port names; a store without
 * folderFiles keeps the Context's default, one project and no global store. */
async function folderReach(store: HippoStore, opts: PromptHookOptions | undefined): Promise<ContextReach | undefined> {
  if (!hasGroup(store, 'folderFiles')) return undefined;
  const { folder } = await store.folderFiles.home();
  const reach = defaultReach(folder, store, opts?.sharedStore, undefined, entryHost);
  return contextReach(reach, loadConfig, resolveEmbeddingProvider);
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
export { isCrossSite, LOOPBACK_HOST_HEADER } from './base/util/http-util.js';
export { clientIpForRateLimit } from './surface/server/client-ip.js';
export { isLoopback, isReservedActor } from './surface/server/auth.js';
export type {
  AddonCall,
  AddonRoute,
  AuthResolver,
  RateLimitSpec,
  ResolvedBearer,
  ServeOpts,
  ServerHandle,
} from './surface/server/types.js';
// ServeOpts takes a HippoStore; the rest of the store contract is on hippo-memory/store-kit.
export type { HippoStore } from './store/index.js';
// An add-on route replies 4xx with HttpError, renders the prompt hook elsewhere with promptHookContext, and types its
// body as JsonValue.
export { HttpError } from './base/util/http-util.js';
export type { CallerProject } from './api/prompt-hook.js';
export type { JsonValue } from './base/util/json.js';
// A session-end route stores the turns its caller read from a transcript on the caller's own machine; it narrows its
// Context with store-kit's hasGroup(ctx.store, 'captures') first.
export {
  captureSessionTexts,
  type CaptureContext,
  type SessionCaptureRequest,
  type SessionCaptureResult,
} from './surface/capture/session-texts.js';
// An add-on's install step mints the first admin key into a store folder it names, which `hippo auth create` cannot
// reach.
export type { AuthCreateOpts, AuthCreateResult };
export { ownerOrSubject } from './api/index.js';
// A route that writes for a session binds it to the caller's owner first; the second name is the 2.x one.
export { bindSessionOwner, bindSessionOwner as bindSessionOwnerOn } from './api/auth/session-owners.js';
// A hook route for a caller on another machine: each call binds the session, then writes under the caller's owner and
// project.
export {
  preCompactForCaller,
  type CallerHookOutput,
  type CallerPreCompactRequest,
} from './surface/capture/pre-compact-caller.js';
export { compactResumeForCaller, type CallerCompactResumeRequest } from './surface/capture/compact-resume-caller.js';
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
export type { WorkingState } from './domain/capture/working-state.js';
