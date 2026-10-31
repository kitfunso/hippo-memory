// A compaction's PreCompact on the store: the twin-fire skip, the boundary record and the merged
// working-state snapshot, for the local hook and for a caller the server answers.

import type { CaptureInput } from '../base/session/capture-contract.js';
import { mergeWorkingState, type WorkingState } from '../base/session/working-state.js';
import type { CompactionStart } from '../base/ports/store/capture.js';
import type { TaskSnapshot } from '../base/ports/store/sessions.js';
import type { ContinuityKey } from '../base/ports/store/types.js';
import { errorFields, errorMessage, log, type LineLog } from '../base/util/log.js';
import type { HippoDbContext } from './hippo-db-context.js';

/** The Copilot CLI accepts both preCompact and PreCompact, so hippo.json's pair can run twice
 * for one compaction. */
const TWIN_FIRE_MS = 10_000;

export type PreCompactContext = Pick<HippoDbContext, 'tenantId' | 'store' | 'infra'>;

/** One accepted PreCompact payload and the host steps around the store's. */
export interface PreCompactRun {
  readonly input: CaptureInput;
  /** The host closes a record with PostCompact, so one is started. */
  readonly closable: boolean;
  /** The host can fire the hook twice for one compaction. */
  readonly twinFires: boolean;
  /** Prints the summarizer's instruction; the text printed, or null when none was. */
  readonly printInstruction: () => string | null;
  /** Called once the boundary is marked, with what was printed. */
  readonly onBoundary?: ((printed: string | null) => void) | undefined;
  /** The transcript's working state, or null when nothing is derivable. */
  readonly workingState: () => WorkingState | null;
  readonly log: LineLog;
}

/** A caller's compaction: its record names the caller's project, and its snapshot is the owner's
 * under `key`. */
export interface CallerCompaction {
  readonly start: CompactionStart;
  readonly key: ContinuityKey;
  /** What the caller read off its transcript; null when nothing was derivable. */
  readonly derived: WorkingState | null;
}

export type CallerPreCompactContext = Pick<HippoDbContext, 'tenantId' | 'store'>;

/** Where a PreCompact's steps report: its progress, and the failures it carries on past. */
interface StepLog {
  readonly note: LineLog;
  readonly failed: LineLog;
}

// A server answers many callers, so only a failure is a warning.
const CALLER_LOG: StepLog = {
  note: (line, opts) => log.debug(`pre-compact: ${line}`, opts?.fields),
  failed: (line, opts) => log.warn(`pre-compact: ${line}`, opts?.fields),
};

/** Records the compaction, asks the summarizer for memories, saves a working-state snapshot.
 * Never extracts memories itself; SessionEnd capture owns that. */
export async function preCompact(ctx: PreCompactContext, run: PreCompactRun): Promise<void> {
  const { sessionId } = run.input;
  if (run.twinFires && (await snapshotJustSaved(ctx, sessionId))) {
    const window = `${TWIN_FIRE_MS / 1000} s`;
    run.log(
      `skip: snapshot for session ${sessionId} saved under ${window} ago, by the other preCompact entry`,
    );
    return;
  }
  const recordId = await markBoundary(ctx, run);
  // Nothing derivable skips the write, so junk never replaces a user-authored active snapshot.
  const derived = run.workingState();
  if (!derived) return;
  const { compactionHooks } = ctx.store.hippoDb;
  await saveDerivedSnapshot(ctx, {
    sessionId,
    key: null,
    derived,
    log: { note: run.log, failed: run.log },
    markSaved:
      recordId === null ? null : () => compactionHooks.markSnapshotSaved(ctx.tenantId, recordId),
  });
}

/** A caller's PreCompact: the record, then the owner's snapshot noted on it, as the local hook
 * takes them. Never throws. */
export async function callerPreCompact(
  ctx: CallerPreCompactContext,
  { start, key, derived }: CallerCompaction,
): Promise<void> {
  const { compactions } = ctx.store.hippoDb;
  const recordId = await startRecord(
    () => compactions.start(ctx.tenantId, start),
    CALLER_LOG.failed,
  );
  if (derived === null) return;
  await saveDerivedSnapshot(ctx, {
    sessionId: start.sessionId,
    key,
    derived,
    log: CALLER_LOG,
    markSaved:
      recordId === null ? null : () => compactions.markSnapshotSaved(ctx.tenantId, recordId),
  });
}

async function snapshotJustSaved(
  ctx: PreCompactContext,
  sessionId: string | null,
): Promise<boolean> {
  if (sessionId === null || sessionId === '') return false;
  const active = await ctx.store.hippoDb.sessions.loadSnapshot(ctx.tenantId, {}, null);
  return (
    active?.sessionId === sessionId &&
    active.source === 'pre-compact' &&
    ctx.infra.clock().getTime() - Date.parse(active.updatedAt) < TWIN_FIRE_MS
  );
}

/** Starts the record when the host will close one, then tells `onBoundary` what was printed; the
 * record id, or null without a record. */
async function markBoundary(ctx: PreCompactContext, run: PreCompactRun): Promise<string | null> {
  const { sessionId, trigger, cwd, transcriptPath } = run.input;
  // The record lands even when no snapshot is derivable later; Copilot has no PostCompact to close
  // one, so its compactions get the snapshot alone.
  let recordId: string | null = null;
  let printed: string | null = null;
  if (run.closable && sessionId !== null && sessionId !== '') {
    const start: Omit<CompactionStart, 'originProject'> = {
      sessionId,
      trigger,
      cwd,
      transcriptPath,
    };
    recordId = await startRecord(
      () => ctx.store.hippoDb.compactionHooks.start(ctx.tenantId, start),
      run.log,
    );
    printed = run.printInstruction();
  }
  // Its own guard, so a throwing callback can never skip the snapshot work that follows.
  try {
    run.onBoundary?.(printed);
  } catch (err) {
    run.log(`boundary callback failed: ${errorMessage(err)}`, { fields: errorFields(err) });
  }
  return recordId;
}

/** Best effort, never throws: a compaction must not fail because its record could not be
 * written. */
async function startRecord(begin: () => Promise<string>, failed: LineLog): Promise<string | null> {
  try {
    return await begin();
  } catch (err) {
    failed(`compaction record not started: ${errorMessage(err)}`, { fields: errorFields(err) });
    return null;
  }
}

interface DerivedSnapshot {
  readonly sessionId: string | null;
  /** The owner's continuity key a caller's snapshot goes under; null for the local hook's. */
  readonly key: ContinuityKey | null;
  readonly derived: WorkingState;
  readonly log: StepLog;
  /** Notes the saved snapshot on the compaction record; null without a record. */
  readonly markSaved: (() => Promise<void>) | null;
}

async function saveDerivedSnapshot(
  ctx: Pick<HippoDbContext, 'tenantId' | 'store'>,
  { sessionId, key, derived, log: steps, markSaved }: DerivedSnapshot,
): Promise<void> {
  const { tenantId, store } = ctx;
  let existing: TaskSnapshot | null = null;
  try {
    existing = await store.hippoDb.sessions.loadSnapshot(tenantId, {}, key);
  } catch (err) {
    log.warn(
      `pre-compact: stored snapshot unreadable, saving the derived one alone: ${errorMessage(err)}`,
      errorFields(err),
    );
  }

  // Carried-over fields are not re-capped, as `hippo snapshot save` stays uncapped;
  // saveActiveTaskSnapshot scrubs every field.
  const merged = mergeWorkingState(derived, existing, sessionId);
  if (merged === null) {
    steps.note(
      'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)',
    );
    return;
  }
  try {
    await store.hippoDb.sessions.save(
      tenantId,
      'snapshot',
      { ...merged, source: 'pre-compact', sessionId },
      key,
    );
    steps.note('snapshot saved');
    if (markSaved !== null) await markSnapshotOnRecord(markSaved, steps.failed);
  } catch (err) {
    steps.failed(`snapshot save failed: ${errorMessage(err)}`, { fields: errorFields(err) });
  }
}

/** Never throws: the snapshot is saved already, and the record only notes it. */
async function markSnapshotOnRecord(
  markSaved: () => Promise<void>,
  failed: LineLog,
): Promise<void> {
  try {
    await markSaved();
  } catch (err) {
    failed(`compaction record not marked with its snapshot: ${errorMessage(err)}`, {
      fields: errorFields(err),
    });
  }
}
