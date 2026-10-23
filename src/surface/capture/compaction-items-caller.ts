// PostCompact for a caller on another machine: the items it parsed become rows under its owner and project, and a
// retried request id writes nothing twice.
import { BadRequestError } from '../../base/errors/api-errors.js';
import type { EntryContext } from '../../api/types.js';
import { COMPACTION_ITEM_MAX_CHARS } from '../../base/util/compaction-items.js';
import { scrubCompactionItems } from './compaction-record.js';
import { log } from '../../base/util/log.js';
import type { CallerProject } from '../../api/prompt-hook.js';
import { assertRequestId, assertTrigger, bindCaller, callerInHoldout } from './caller-session.js';
import { withEntryInfra } from '../entry-infra.js';

export interface CallerItemsRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly trigger: string | null;
  /** The "Memories for hippo" list the caller parsed from its compact summary. */
  readonly items: readonly string[];
  readonly requestId: string;
}

export interface CallerItemsResult {
  readonly written: number;
}

/**
 * Busy rejects, for the server's 503: the retry carries the same request id, so nothing is spooled or deferred here.
 */
export async function saveCompactionItemsForCaller(
  given: EntryContext,
  req: CallerItemsRequest,
): Promise<CallerItemsResult> {
  const ctx = withEntryInfra(given);
  assertTrigger(req.trigger);
  assertRequestId(req.requestId);
  // Refused before the scrub, as failure text is, so the cut after it only ever takes back a mask's growth.
  if (req.items.some((item) => item.length > COMPACTION_ITEM_MAX_CHARS)) {
    throw new BadRequestError(`items: each at most ${COMPACTION_ITEM_MAX_CHARS} characters`);
  }
  const key = await bindCaller(ctx, req.sessionId, req.project);
  if (await callerInHoldout(ctx, req.sessionId)) return { written: 0 };
  const { written, notes } = await ctx.store.compactions.saveCallerItems(ctx.tenantId, {
    sessionId: req.sessionId,
    trigger: req.trigger,
    requestId: req.requestId,
    project: req.project.name,
    items: scrubCompactionItems(req.items),
    owner: key.owner,
    origins: key.project,
    baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
  });
  for (const note of notes) log.info(`post-compact: ${note}`);
  return { written };
}
