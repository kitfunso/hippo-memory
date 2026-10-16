// The store writes a session's end makes after sleep and capture (handoff, snapshot close, re-read count), and the
// compact-resume read; the hook verbs keep stdin, spawning and the log file.

import * as path from 'path';
import type { HandoffEvidence } from '../core/handoff.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import { readApiCalls, recordRereads, type TranscriptCalls } from '../store/token-ledger.js';
import { truncateCodePointSafe } from '../util/transcript-tail.js';
import { errorMessage, log, errorFields } from '../util/log.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from './context-render.js';
import type { Context, ContextWith } from './types.js';

/** What closing one ended session needs from the host; the two readers run only when the handoff is written. */
export interface SessionClose {
  sessionId: string | null;
  /** A reply's end, not the session's: the handoff is updated in place and the snapshot stays for the next
   * compaction. */
  turn: boolean;
  /** The transcript's working state, or null with no readable transcript. */
  workingState: () => Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null;
  evidence: () => HandoffEvidence;
  /** One line to the session-end log. */
  log: (line: string) => void;
}

/** Writes the session's handoff, then closes its snapshot unless `turn`; each step logs its own failure and never
 * throws. The handoff goes first, while the snapshot writeSessionEndHandoff reads is still active. */
export async function closeEndedSession(ctx: ContextWith<'sessions'>, close: SessionClose): Promise<void> {
  if (close.sessionId) await writeEndHandoff(ctx, close.sessionId, close);
  if (close.turn) {
    close.log('skip snapshot close: turn mode');
    return;
  }
  await closeSnapshot(ctx, close.sessionId, close.log);
}

async function writeEndHandoff(ctx: ContextWith<'sessions'>, sessionId: string, close: SessionClose): Promise<void> {
  const { sessions } = ctx.store;
  try {
    const ownSnapshot = (await sessions.loadSnapshot(ctx.tenantId, null))?.session_id === sessionId;
    // A never-compacted session has no snapshot; read even when it has one, as another session's PreCompact can take
    // the slot before the write.
    const derived = close.workingState();
    if (!ownSnapshot && !derived) {
      close.log('skip: no snapshot or transcript for session');
      return;
    }
    const handoff = await sessions.writeSessionEndHandoff(ctx.tenantId, {
      sessionId,
      evidence: close.evidence(),
      derived,
      inPlace: close.turn,
    });
    close.log(
      handoff ? `wrote handoff for session ${sessionId}` : `skip: kept the existing handoff for session ${sessionId}`,
    );
  } catch (err) {
    close.log(`handoff write failed: ${errorMessage(err)}`);
  }
}

// If session-end never fires (crash, kill -9), the freshness bound in loadFreshActiveTaskSnapshot is the backstop.
async function closeSnapshot(
  ctx: ContextWith<'sessions'>,
  sessionId: string | null,
  line: (message: string) => void,
): Promise<void> {
  try {
    if (sessionId) {
      const closed = await ctx.store.sessions.closeSessionSnapshots(ctx.tenantId, sessionId, 'session-ended', null);
      line(`closed ${closed} active snapshot(s) for session ${sessionId}`);
    } else {
      line('skip: no session_id in SessionEnd payload, active snapshot left untouched');
    }
  } catch (err) {
    line(`snapshot close failed: ${errorMessage(err)}`);
  }
}

/** Books the ending session's re-reads in each store its ledger rows can land in (`ctx.hippoRoot` and global); returns
 * the log lines. */
export async function bookSessionRereads(
  ctx: Context,
  transcriptPath: string | undefined,
  sessionId: string | null,
): Promise<string[]> {
  if (!transcriptPath || !sessionId) return [];
  let read: TranscriptCalls;
  try {
    read = await readApiCalls(transcriptPath);
  } catch (err) {
    return [`skip re-read count: cannot read the transcript: ${errorMessage(err)}`];
  }
  const roots = new Set(
    [(ctx.reach?.hasLocal ?? true) ? ctx.hippoRoot : null, ctx.reach?.global?.root]
      .flatMap((root) => (root ? [path.resolve(root)] : [])),
  );
  const lines: string[] = [];
  let tokens = 0;
  for (const root of roots) {
    try {
      tokens += recordRereads(root, ctx.tenantId, sessionId, read.calls);
    } catch (err) {
      lines.push(`re-read count failed: ${errorMessage(err)}`);
    }
  }
  const skipped = read.malformed > 0 ? `, ${read.malformed} unparsable transcript lines skipped` : '';
  lines.push(`re-read ${tokens} tokens over ${read.calls.length} model calls for session ${sessionId}${skipped}`);
  return lines;
}

/** The block a compaction lost: the fresh task snapshot and its session trail, or null with none or another session's
 * snapshot. */
export async function compactResumeBlock(
  ctx: ContextWith<'sessions'>,
  payloadSessionId: string | null,
): Promise<string | null> {
  const { sessions } = ctx.store;
  const snapshot = await sessions.loadFreshSnapshot(ctx.tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS }, null);
  // Concurrent sessions must not cross-restore: only when both ids are present and differ, so a manual run with no
  // payload id still prints.
  if (!snapshot) return null;
  if (payloadSessionId !== null && snapshot.session_id !== null && payloadSessionId !== snapshot.session_id) {
    return null;
  }
  // A bad trail row costs the trail, not the snapshot; stderr stays out of the model's context.
  let events: SessionEvent[] = [];
  try {
    if (snapshot.session_id) {
      events = (await sessions.listEvents(ctx.tenantId, { sessionId: snapshot.session_id })).map((e) => ({
        ...e,
        content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
      }));
    }
  } catch (err) {
    log.warn(`hippo compact-resume: trail skipped: ${errorMessage(err)}`, errorFields(err));
  }
  return compactResumeText(snapshot, events);
}

/** What one session-end run needs from its host; the host owns sleep, transcript reading and capture, this module owns
 * the order. */
export interface SessionEndWork<Scan> {
  mode: 'turn' | 'full';
  hippoRoot: string;
  tenantId: string;
  sessionId: string | null;
  transcriptPath: string | undefined;
  /** Builds the call context for one store root. */
  contextFor: (root: string) => ContextWith<'sessions'>;
  /** The store the run captures into: the project store, else global; null when neither exists. */
  storeRoot: () => string | null;
  /** One line to the session-end log; `startFresh` restarts the file. */
  log: (line: string, opts?: { startFresh?: boolean }) => void;
  sleep: () => Promise<void>;
  readScan: (log: (line: string) => void) => Scan | null;
  capture: (store: string, scan: Scan | null) => void;
  digest: (scan: Scan | null, log: (line: string) => void) => void;
  workingState: (log: (line: string) => void) => ReturnType<SessionClose['workingState']>;
  evidence: () => HandoffEvidence;
}

/** Books re-reads, sleeps, captures, digests and closes one ended session, in that order. */
export async function sessionEndWork<Scan>(w: SessionEndWork<Scan>): Promise<void> {
  const rereadLog = await bookSessionRereads(w.contextFor(w.hippoRoot), w.transcriptPath, w.sessionId)
    .catch((err) => [`re-read count failed: ${errorMessage(err)}`]);
  // Sleep starts the log file afresh, so the lines go in after it; on exit too, in case sleep exits the process. A
  // flushed log drops its exit listener, so a long-lived host does not gain one per session; it stays only while lines
  // wait.
  const flushRereadLog = (): void => {
    process.off('exit', flushRereadLog);
    for (const line of rereadLog.splice(0)) w.log(line);
  };
  process.once('exit', flushRereadLog);
  // A folder with neither a project nor a global store must not get one made.
  const store = w.storeRoot();
  if (store === null) {
    w.log('skip: no hippo store for this folder or globally', { startFresh: true });
    flushRereadLog();
    return;
  }
  await w.sleep();
  flushRereadLog();
  const scan = w.readScan((line) => w.log(line));
  w.capture(store, scan);
  w.digest(scan, (line) => w.log(line));
  // Only this session's snapshot, and only after sleep and capture.
  const closeLog = (line: string): void => w.log(line);
  await closeEndedSession(w.contextFor(store), {
    sessionId: w.sessionId,
    turn: w.mode === 'turn',
    workingState: () => (w.transcriptPath ? w.workingState(closeLog) : null),
    evidence: w.evidence,
    log: closeLog,
  });
}
