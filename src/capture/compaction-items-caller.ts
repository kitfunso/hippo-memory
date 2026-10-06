// PostCompact for a caller on another machine: the items it parsed become rows under its owner and project, and a retried request id writes nothing twice.
import type { Context } from '../api/types.js';
import { compactionByRequest, recordSummary, saveItems, scrubCompactionItems } from '../compaction-record.js';
import { log } from '../log.js';
import type { CallerProject } from '../prompt-hook.js';
import { assertRequestId, assertTrigger, bindCaller, callerInHoldout, withCallerDb } from './caller-session.js';

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

/** Busy throws, for the server's 503: the retry carries the same request id, so nothing is spooled or deferred here. */
export function saveCompactionItemsForCaller(ctx: Context, req: CallerItemsRequest): CallerItemsResult {
  assertTrigger(req.trigger);
  assertRequestId(req.requestId);
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (callerInHoldout(ctx, req.sessionId)) return { written: 0 };
  return withCallerDb(ctx, (db) => {
    const earlier = compactionByRequest(db, ctx.tenantId, req.requestId);
    // Past `summarised` the first try finished, so its count is the answer; a `summarised` one failed at the items and is reused.
    if (earlier !== null && earlier.status !== 'summarised') return { written: earlier.itemsWritten };
    const meta = { sessionId: req.sessionId, trigger: req.trigger, cwd: null, transcriptPath: null };
    const text = { summary: '', items: scrubCompactionItems(req.items) };
    const record = earlier ?? recordSummary(db, ctx.hippoRoot, ctx.tenantId, meta, text, new Date(), { originProject: req.project.name, requestId: req.requestId });
    const written = saveItems(db, ctx.hippoRoot, {
      tenantId: ctx.tenantId, recordId: record.id, sessionId: req.sessionId, originProject: record.originProject, cwd: null,
      items: record.items, caller: { actor: key.owner, origins: key.project },
    }, (message) => log.info(`post-compact: ${message}`));
    return { written };
  });
}
