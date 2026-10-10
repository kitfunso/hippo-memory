// A session id belongs to the first owner that binds it, so one developer's client cannot write into another's session.
import { ConflictError } from '../core/api-errors.js';
import { ownerOrSubject, type Context } from './types.js';
import { sessionOwnerOrBind } from '../store/sessions.js';
import { assertTenantId } from '../store/tenant.js';
import { DAY_MS } from '../util/time.js';

/** Bindings older than this are pruned when a new session binds. */
const BINDING_RETENTION_DAYS = 90;

/** Binds `sessionId` to the caller's owner on first use; a session another owner holds is a 409, so the client can set it aside. */
export function bindSessionOwner(ctx: Context, sessionId: string): void {
  assertTenantId('bindSessionOwner', ctx.tenantId);
  const owner = ownerOrSubject(ctx.actor);
  const bound = sessionOwnerOrBind(ctx.hippoRoot, { tenantId: ctx.tenantId, sessionId, owner, retentionMs: BINDING_RETENTION_DAYS * DAY_MS });
  if (bound !== owner) throw new ConflictError('session id belongs to another caller');
}
