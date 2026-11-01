// SessionStart after a compaction, for a caller on another machine: the owner's fresh snapshot for
// this session, as the local hook prints it.
import type { EntryContext } from '../../api/types.js';
import { bookTokenUse, ledgerReachOf } from '../../api/ledger-db.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import { compactResumeBlock } from '../../api/session-end.js';
import { estimateTokens } from '../../base/util/token-text.js';
import { bindCaller, callerInHoldout } from './caller-session.js';
import type { CallerHookOutput } from './pre-compact-caller.js';
import { withEntryInfra } from '../entry-infra.js';
import { withHippoDb } from '../../api/hippo-db-context.js';

export interface CallerCompactResumeRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  /** The SessionStart payload's source; only 'compact' restores. */
  readonly source: string;
}

export async function compactResumeForCaller(
  given: EntryContext,
  req: CallerCompactResumeRequest,
): Promise<CallerHookOutput> {
  const ctx = withHippoDb(withEntryInfra(given));
  const key = await bindCaller(ctx, req.sessionId, req.project);
  if (req.source !== 'compact' || (await callerInHoldout(ctx, req.sessionId))) {
    return { stdout: '' };
  }
  const text = await compactResumeBlock(ctx, req.sessionId, key);
  if (text === null) return { stdout: '' };
  await bookTokenUse(
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
