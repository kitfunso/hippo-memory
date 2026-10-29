// A compaction's PreCompact on the store: the twin-fire skip, the boundary record and the merged
// working-state snapshot. The hook verb keeps stdin, the transcript, stdout and the log file.

import type { CaptureInput } from '../base/session/capture-contract.js';
import { mergeWorkingState, type WorkingState } from '../base/session/working-state.js';
import type { CompactionStart } from '../base/ports/store/capture.js';
import type { TaskSnapshot } from '../base/ports/store/sessions.js';
import { errorFields, errorMessage, log, type LineLog } from '../base/util/log.js';
import type { ContextWith } from './types.js';

/** The Copilot CLI accepts both preCompact and PreCompact, so hippo.json's pair can run twice
 * for one compaction. */
const TWIN_FIRE_MS = 10_000;

export type PreCompactContext = Pick<
  ContextWith<'compactionHooks' | 'sessions'>,
  'tenantId' | 'store' | 'infra'
>;

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
  await saveDerivedSnapshot(ctx, { sessionId, recordId, derived, log: run.log });
}

async function snapshotJustSaved(
  ctx: PreCompactContext,
  sessionId: string | null,
): Promise<boolean> {
  if (sessionId === null || sessionId === '') return false;
  const active = await ctx.store.sessions.loadSnapshot(ctx.tenantId, {}, null);
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
    recordId = await startRecord(ctx, { sessionId, trigger, cwd, transcriptPath }, run.log);
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
async function startRecord(
  ctx: PreCompactContext,
  start: Omit<CompactionStart, 'originProject'>,
  logLine: LineLog,
): Promise<string | null> {
  try {
    return await ctx.store.compactionHooks.start(ctx.tenantId, start);
  } catch (err) {
    logLine(`compaction record not started: ${errorMessage(err)}`, { fields: errorFields(err) });
    return null;
  }
}

interface DerivedSnapshot {
  readonly sessionId: string | null;
  readonly recordId: string | null;
  readonly derived: WorkingState;
  readonly log: LineLog;
}

async function saveDerivedSnapshot(
  ctx: PreCompactContext,
  { sessionId, recordId, derived, log: logLine }: DerivedSnapshot,
): Promise<void> {
  const { tenantId, store } = ctx;
  let existing: TaskSnapshot | null = null;
  try {
    existing = await store.sessions.loadSnapshot(tenantId, {}, null);
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
    logLine(
      'skip: no snapshot content for this session (nothing derivable; fallback blocked or empty)',
    );
    return;
  }
  try {
    await store.sessions.save(
      tenantId,
      'snapshot',
      { ...merged, source: 'pre-compact', sessionId },
      null,
    );
    logLine('snapshot saved');
    if (recordId !== null) await markSnapshotOnRecord(ctx, recordId, logLine);
  } catch (err) {
    logLine(`snapshot save failed: ${errorMessage(err)}`, { fields: errorFields(err) });
  }
}

/** Never throws: the snapshot is saved already, and the record only notes it. */
async function markSnapshotOnRecord(
  ctx: PreCompactContext,
  recordId: string,
  logLine: LineLog,
): Promise<void> {
  try {
    await ctx.store.compactionHooks.markSnapshotSaved(ctx.tenantId, recordId);
  } catch (err) {
    logLine(`compaction record not marked with its snapshot: ${errorMessage(err)}`, {
      fields: errorFields(err),
    });
  }
}
