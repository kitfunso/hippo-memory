// SessionStart after a compaction, for a caller on another machine: the owner's fresh snapshot for this session, as the local hook prints it.
import type { Context } from '../api/types.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from '../context-render.js';
import { withLedgerDb } from '../ledger-db.js';
import { errorMessage, log } from '../log.js';
import type { CallerProject } from '../prompt-hook.js';
import type { SessionEvent } from '../store/rows.js';
import { listSessionEvents, loadFreshActiveTaskSnapshot } from '../store/sessions.js';
import { estimateTokens, recordTokenUse } from '../token-ledger.js';
import { truncateCodePointSafe } from '../transcript-tail.js';
import { bindCaller, callerInHoldout } from './caller-session.js';
import type { CallerHookOutput } from './pre-compact-caller.js';

export interface CallerCompactResumeRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The SessionStart payload's source; only 'compact' restores. */
  readonly source: string;
}

export function compactResumeForCaller(ctx: Context, req: CallerCompactResumeRequest): CallerHookOutput {
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (req.source !== 'compact' || callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const snapshot = loadFreshActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS }, key);
  // One owner's concurrent sessions must not cross-restore; a snapshot with no session still restores, as on the local path.
  if (snapshot === null || (snapshot.session_id !== null && snapshot.session_id !== req.sessionId)) return { stdout: '' };
  const text = compactResumeText(snapshot, sessionTrail(ctx, snapshot.session_id));
  withLedgerDb(ctx.hippoRoot, (db) => recordTokenUse(db, {
    tenantId: ctx.tenantId, sessionId: req.sessionId, surface: 'compact_resume', event: 'inject', items: 1, tokens: estimateTokens(text),
  }), { sharedStore: true });
  return { stdout: text };
}

/** A bad trail row costs the trail, not the snapshot. */
function sessionTrail(ctx: Context, sessionId: string | null): SessionEvent[] {
  if (!sessionId) return [];
  try {
    return listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: sessionId })
      .map((e) => ({ ...e, content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP) }));
  } catch (err) {
    log.warn(`compact-resume: trail skipped: ${errorMessage(err)}`);
    return [];
  }
}
