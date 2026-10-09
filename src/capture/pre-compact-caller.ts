// PreCompact for a caller on another machine: the record and the owner's snapshot go under its tenant and project; only a refused bind or the holdout arm withholds the instruction.
import type { Context, StoreReply } from '../api/types.js';
import { markSnapshotSaved, PRE_COMPACT_INSTRUCTION, startCompaction } from '../compaction-record.js';
import { rethrowIfSqliteBlocked } from '../db.js';
import { errorMessage, log } from '../log.js';
import { generateId } from '../memory.js';
import type { CallerProject } from '../prompt-hook.js';
import { requireGroup, type HookStore } from '../store-port.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot, type ContinuityKey } from '../store/sessions.js';
import {
  assertTrigger, bindCaller, bindCallerThroughStore, callerInHoldout, callerInHoldoutThroughStore, checkedWorkingState, withCallerDb, type StoreContext,
} from './caller-session.js';
import { mergeWorkingState, type WorkingState } from './working-state.js';

export interface CallerPreCompactRequest {
  readonly sessionId: string;
  readonly project: CallerProject;
  readonly trigger: string | null;
  /** What the caller read off its transcript; null when nothing was derivable. */
  readonly workingState: WorkingState | null;
}

export interface CallerHookOutput {
  /** What the hook prints; '' prints nothing. */
  readonly stdout: string;
}

/** A failed step is logged and the instruction still goes out, as the local hook prints it before any store work. */
function logged<T>(what: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (err) {
    log.warn(`pre-compact: ${what}: ${errorMessage(err)}`);
    return null;
  }
}

/** With `ctx.store`, its hooks group reads and writes, and the snapshot is saved before the record starts so one call can mark it. */
export function preCompactForCaller<C extends Context>(ctx: C, req: CallerPreCompactRequest): StoreReply<C, CallerHookOutput> {
  const reply = ctx.store ? preCompactThroughStore({ ...ctx, store: ctx.store }, req) : preCompactOnHippoDb(ctx, req);
  // SAFETY: a C typed with a store gets the promise its path returns; a wide C is typed as the union, which a caller has to await anyway.
  return reply as StoreReply<C, CallerHookOutput>;
}

function preCompactOnHippoDb(ctx: Context, req: CallerPreCompactRequest): CallerHookOutput {
  assertTrigger(req.trigger);
  const state = checkedWorkingState(req.workingState);
  const key = bindCaller(ctx, req.sessionId, req.project);
  if (callerInHoldout(ctx, req.sessionId)) return { stdout: '' };
  const start = { sessionId: req.sessionId, originProject: req.project.name, trigger: req.trigger, cwd: null, transcriptPath: null };
  const recordId = logged('compaction record not started', () => withCallerDb(ctx, (db) => startCompaction(db, ctx.tenantId, start)));
  if (state !== null && saveOwnerSnapshot(ctx, req.sessionId, key, state) && recordId !== null) {
    // Marked under ctx.tenantId, which the environment's tenant may not be.
    logged('compaction record not marked with its snapshot', () => withCallerDb(ctx, (db) => markSnapshotSaved(db, ctx.tenantId, recordId)));
  }
  return { stdout: PRE_COMPACT_INSTRUCTION };
}

/** True when the owner's snapshot was saved. */
function saveOwnerSnapshot(ctx: Context, sessionId: string, key: ContinuityKey, state: WorkingState): boolean {
  const existing = logged('snapshot not loaded', () => loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, key));
  const merged = mergeWorkingState(state, existing, sessionId);
  if (merged === null) return false;
  const snapshot = { ...merged, source: 'pre-compact', session_id: sessionId };
  return logged('snapshot not saved', () => saveActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, snapshot, key)) !== null;
}

async function preCompactThroughStore(ctx: StoreContext, req: CallerPreCompactRequest): Promise<CallerHookOutput> {
  const hooks = requireGroup(ctx.store, 'hooks');
  assertTrigger(req.trigger);
  const state = checkedWorkingState(req.workingState);
  const key = await bindCallerThroughStore(ctx, req.sessionId, req.project);
  if (await callerInHoldoutThroughStore(ctx, hooks, req.sessionId)) return { stdout: '' };
  const snapshotSaved = state !== null && await saveSnapshotThroughStore(ctx, hooks, req.sessionId, key, state);
  await loggedAsync('compaction record not started', () => hooks.startCompaction({
    tenantId: ctx.tenantId, id: generateId('cmp'), sessionId: req.sessionId, originProject: req.project.name,
    trigger: req.trigger, startedAt: new Date().toISOString(), snapshotSaved,
  }));
  return { stdout: PRE_COMPACT_INSTRUCTION };
}

async function saveSnapshotThroughStore(ctx: StoreContext, hooks: HookStore, sessionId: string, key: ContinuityKey, state: WorkingState): Promise<boolean> {
  const existing = await loggedAsync('snapshot not loaded', async () => (await ctx.store.continuity(ctx.tenantId, 1, key)).activeSnapshot);
  const merged = mergeWorkingState(state, existing, sessionId);
  if (merged === null) return false;
  const snapshot = { ...merged, source: 'pre-compact', session_id: sessionId };
  return (await loggedAsync('snapshot not saved', () => hooks.saveSnapshot(ctx.tenantId, snapshot, key))) !== null;
}

async function loggedAsync<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    rethrowIfSqliteBlocked(err);
    log.warn(`pre-compact: ${what}: ${errorMessage(err)}`);
    return null;
  }
}
