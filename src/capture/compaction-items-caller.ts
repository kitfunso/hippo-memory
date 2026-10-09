// PostCompact for a caller on another machine: the items it parsed become rows under its owner and project, and a retried request id writes nothing twice.
import { BadRequestError } from '../api-errors.js';
import type { Context, StoreReply } from '../api/types.js';
import { isRecallBoostAblated } from '../ablation.js';
import { COMPACTION_ITEM_MAX_CHARS } from '../compaction-items.js';
import {
  compactionByRequest, compactionEntry, itemRowsToWrite, logItemSkips, ownRequestRecord, planItemRows, recordSummary, saveItems, scrubCompactionItems,
  type CompactionRecord,
} from '../compaction-record.js';
import { loadConfig } from '../config.js';
import { writeGateRefusal } from '../gated-write.js';
import { log } from '../log.js';
import { generateId } from '../memory.js';
import type { CallerProject } from '../prompt-hook.js';
import { rejectionDigest } from '../rejection.js';
import { requireGroup, type CompactionItemStep, type HookStore } from '../store-port.js';
import type { ContinuityKey } from '../store/sessions.js';
import {
  assertRequestId, assertTrigger, bindCaller, bindCallerThroughStore, callerInHoldout, callerInHoldoutThroughStore, withCallerDb, type StoreContext,
} from './caller-session.js';

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

const itemLog = (message: string): void => log.info(`post-compact: ${message}`);

/** Busy throws, for the server's 503: the retry carries the same request id, so nothing is spooled or deferred here. With `ctx.store`, its hooks group reads and writes. */
export function saveCompactionItemsForCaller<C extends Context>(ctx: C, req: CallerItemsRequest): StoreReply<C, CallerItemsResult> {
  const reply = ctx.store ? itemsThroughStore({ ...ctx, store: ctx.store }, req) : itemsOnHippoDb(ctx, req);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, CallerItemsResult>;
}

function assertItemsRequest(req: CallerItemsRequest): void {
  assertTrigger(req.trigger);
  assertRequestId(req.requestId);
  // Refused before the scrub, as failure text is, so the cut after it only ever takes back a mask's growth.
  if (req.items.some((item) => item.length > COMPACTION_ITEM_MAX_CHARS)) throw new BadRequestError(`items: each at most ${COMPACTION_ITEM_MAX_CHARS} characters`);
}

function itemsOnHippoDb(ctx: Context, req: CallerItemsRequest): CallerItemsResult {
  assertItemsRequest(req);
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (callerInHoldout(ctx, req.sessionId)) return { written: 0 };
  return withCallerDb(ctx, (db) => {
    const earlier = compactionByRequest(db, ctx.tenantId, req.requestId, req.sessionId);
    // Past `summarised` the first try finished, so its count is the answer; a `summarised` one failed at the items and is reused.
    if (earlier !== null && earlier.status !== 'summarised') return { written: earlier.itemsWritten };
    const meta = { sessionId: req.sessionId, trigger: req.trigger, cwd: null, transcriptPath: null };
    const text = { summary: '', items: scrubCompactionItems(req.items) };
    const record = earlier ?? recordSummary(db, ctx.hippoRoot, ctx.tenantId, meta, text, new Date(), { originProject: req.project.name, requestId: req.requestId });
    const written = saveItems(db, ctx.hippoRoot, {
      tenantId: ctx.tenantId, recordId: record.id, sessionId: req.sessionId, originProject: record.originProject, cwd: null,
      items: record.items, caller: { actor: key.owner, origins: key.project },
    }, itemLog);
    return { written };
  });
}

async function itemsThroughStore(ctx: StoreContext, req: CallerItemsRequest): Promise<CallerItemsResult> {
  const hooks = requireGroup(ctx.store, 'hooks');
  assertItemsRequest(req);
  const key = await bindCallerThroughStore(ctx, req.sessionId, req.project);
  if (await callerInHoldoutThroughStore(ctx, hooks, req.sessionId)) return { written: 0 };
  const earlier = ownRequestRecord(await hooks.compactionByRequest(ctx.tenantId, req.requestId), req.sessionId);
  if (earlier !== null && earlier.status !== 'summarised') return { written: earlier.itemsWritten };
  const record = earlier ?? await hooks.summariseCompaction({
    tenantId: ctx.tenantId, id: generateId('cmp'), sessionId: req.sessionId, trigger: req.trigger, originProject: req.project.name,
    requestId: req.requestId, summary: '', items: scrubCompactionItems(req.items), at: new Date().toISOString(),
  });
  return { written: await writeRecordItems(ctx, hooks, record, key) };
}

/** saveItems through the store: the plan runs inside its transaction, the gate and tombstone checks as gatedWrite makes them. */
async function writeRecordItems(ctx: StoreContext, hooks: HookStore, record: CompactionRecord, key: ContinuityKey): Promise<number> {
  const rows = itemRowsToWrite(record.items, itemLog);
  const baseHalfLifeDays = loadConfig(ctx.hippoRoot).defaultHalfLifeDays;
  const ids = { tenantId: ctx.tenantId, sessionId: record.sessionId };
  let skips = { repeats: 0, refused: 0 };
  const result = await hooks.writeCompactionItems({
    tenantId: ctx.tenantId, recordId: record.id, actor: key.owner, origins: key.project, digests: rows.map(rejectionDigest),
    strengthen: { tenantId: ctx.tenantId, recallBoostAblated: isRecallBoostAblated() },
    plan: (held, tombstones) => {
      const steps: CompactionItemStep[] = [];
      const writes = planItemRows(held, record.sessionId, rows, (text) => compactionEntry(text, ids, record.originProject, baseHalfLifeDays), (entry) => {
        if (writeGateRefusal(entry) !== null) return false;
        const digest = rejectionDigest(entry.content);
        const tombstone = tombstones.get(digest);
        steps.push(tombstone ? { refuse: { entryId: entry.id, digest, reason: tombstone.reason } } : { write: entry });
        return tombstone === undefined;
      });
      skips = writes;
      return { steps, restated: writes.restated };
    },
  });
  if (result.alreadyDone) itemLog(`${record.id} was already finished by another process`);
  else logItemSkips(skips, itemLog);
  return result.written;
}
