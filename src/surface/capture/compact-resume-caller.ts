// SessionStart after a compaction, for a caller on another machine: the owner's fresh snapshot for this session, as the
// local hook prints it.
import type { Context } from '../../api/types.js';
import {
  COMPACT_RESUME_EVENT_CONTENT_CAP,
  COMPACT_RESUME_MAX_AGE_MS,
  compactResumeText,
} from '../../api/context-render.js';
import { bookTokenUse, ledgerReachOf } from '../../api/ledger-db.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import type { Sessions } from '../../store/port-groups.js';
import type { SessionEvent } from '../../store/port/sessions.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { truncateCodePointSafe } from '../../base/util/transcript-tail.js';
import { bindCaller, callerInHoldout } from './caller-session.js';
import type { CallerHookOutput } from './pre-compact-caller.js';

export interface CallerCompactResumeRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The SessionStart payload's source; only 'compact' restores. */
  readonly source: string;
}

export async function compactResumeForCaller(ctx: Context, req: CallerCompactResumeRequest): Promise<CallerHookOutput> {
  const key = await bindCaller(ctx, req.sessionId, req.project);
  if (req.source !== 'compact' || callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const { sessions } = ctx.store;
  const snapshot = await sessions.loadFreshSnapshot(ctx.tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS }, key);
  // One owner's concurrent sessions must not cross-restore; a snapshot with no session still restores, as on the local
  // path.
  if (snapshot === null || (snapshot.session_id !== null && snapshot.session_id !== req.sessionId)) {
    return { stdout: '' };
  }
  const text = compactResumeText(snapshot, await sessionTrail(ctx, sessions, snapshot.session_id));
  bookTokenUse(
    {
      tenantId: ctx.tenantId,
      sessionId: req.sessionId,
      surface: 'compact_resume',
      event: 'inject',
      items: 1,
      tokens: estimateTokens(text),
    },
    ledgerReachOf(ctx, true),
  );
  return { stdout: text };
}

/** A bad trail row costs the trail, not the snapshot. */
async function sessionTrail(ctx: Context, sessions: Sessions, sessionId: string | null): Promise<SessionEvent[]> {
  if (!sessionId) return [];
  try {
    return (await sessions.listEvents(ctx.tenantId, { sessionId })).map((e) => ({
      ...e,
      content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
    }));
  } catch (err) {
    log.warn(`compact-resume: trail skipped: ${errorMessage(err)}`, errorFields(err));
    return [];
  }
}
