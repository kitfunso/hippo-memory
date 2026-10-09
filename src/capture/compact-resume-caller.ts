// SessionStart after a compaction, for a caller on another machine: the owner's fresh snapshot for this session, as the local hook prints it.
import type { Context, StoreReply } from '../api/types.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from '../context-render.js';
import { rethrowIfSqliteBlocked } from '../db.js';
import { withLedgerDb } from '../ledger-db.js';
import { errorMessage, log } from '../log.js';
import type { CallerProject } from '../prompt-hook.js';
import { requireGroup } from '../store-port.js';
import type { SessionEvent } from '../store/rows.js';
import { freshActiveSnapshot, listSessionEvents, loadFreshActiveTaskSnapshot } from '../store/sessions.js';
import { estimateTokens, recordTokenUse, type TokenUse } from '../token-ledger.js';
import { truncateCodePointSafe } from '../transcript-tail.js';
import { bindCaller, bindCallerThroughStore, callerInHoldout, callerInHoldoutThroughStore, type StoreContext } from './caller-session.js';
import type { CallerHookOutput } from './pre-compact-caller.js';

export interface CallerCompactResumeRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The SessionStart payload's source; only 'compact' restores. */
  readonly source: string;
}

/** With `ctx.store`, the snapshot and trail come from its continuity read in one call, so a bad trail row fails the call there. */
export function compactResumeForCaller<C extends Context>(ctx: C, req: CallerCompactResumeRequest): StoreReply<C, CallerHookOutput> {
  const reply = ctx.store ? resumeThroughStore({ ...ctx, store: ctx.store }, req) : resumeOnHippoDb(ctx, req);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, CallerHookOutput>;
}

async function resumeThroughStore(ctx: StoreContext, req: CallerCompactResumeRequest): Promise<CallerHookOutput> {
  const hooks = requireGroup(ctx.store, 'hooks');
  const key = await bindCallerThroughStore(ctx, req.sessionId, req.project);
  if (req.source !== 'compact' || await callerInHoldoutThroughStore(ctx, hooks, req.sessionId)) return { stdout: '' };
  const block = await ctx.store.continuity(ctx.tenantId, RESUME_TRAIL_EVENTS, key);
  const snapshot = freshActiveSnapshot(block.activeSnapshot, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS });
  if (snapshot === null || (snapshot.session_id !== null && snapshot.session_id !== req.sessionId)) return { stdout: '' };
  const trail = snapshot.session_id ? block.recentSessionEvents.map(cappedEvent) : [];
  const text = compactResumeText(snapshot, trail);
  try {
    await ctx.store.recordTokens(resumeTokens(ctx, req.sessionId, text));
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warnThenDebug('compact-resume-ledger', `token ledger write failed; the reply is unaffected: ${errorMessage(err)}`);
  }
  return { stdout: text };
}

function resumeOnHippoDb(ctx: Context, req: CallerCompactResumeRequest): CallerHookOutput {
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (req.source !== 'compact' || callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const snapshot = loadFreshActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS }, key);
  // One owner's concurrent sessions must not cross-restore; a snapshot with no session still restores, as on the local path.
  if (snapshot === null || (snapshot.session_id !== null && snapshot.session_id !== req.sessionId)) return { stdout: '' };
  const text = compactResumeText(snapshot, sessionTrail(ctx, snapshot.session_id));
  withLedgerDb(ctx.hippoRoot, (db) => recordTokenUse(db, resumeTokens(ctx, req.sessionId, text)), { sharedStore: true });
  return { stdout: text };
}

/** listSessionEvents' default, so both paths restore the same trail. */
const RESUME_TRAIL_EVENTS = 8;

function resumeTokens(ctx: Context, sessionId: string, text: string): TokenUse {
  return { tenantId: ctx.tenantId, sessionId, surface: 'compact_resume', event: 'inject', items: 1, tokens: estimateTokens(text) };
}

function cappedEvent(e: SessionEvent): SessionEvent {
  return { ...e, content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP) };
}

/** A bad trail row costs the trail, not the snapshot. */
function sessionTrail(ctx: Context, sessionId: string | null): SessionEvent[] {
  if (!sessionId) return [];
  try {
    return listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId, limit: RESUME_TRAIL_EVENTS }).map(cappedEvent);
  } catch (err) {
    log.warn(`compact-resume: trail skipped: ${errorMessage(err)}`);
    return [];
  }
}
