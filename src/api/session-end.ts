// A session's end: which store it writes to, when it sleeps, which turns it captures, and the store writes after them
// (handoff, snapshot close, re-read count); plus the compact-resume read. The hook verbs keep stdin, spawning and
// the log file.

import * as path from 'path';
import type { HandoffEvidence } from '../core/handoff.js';
import type { ProjectRef } from '../core/project-identity.js';
import type { SessionEvent, TaskSnapshot } from '../store/port/sessions.js';
import type { LocalFiles } from '../store/port.js';
import { readApiCalls, type TranscriptCalls } from '../core/transcript-calls.js';
import { truncateCodePointSafe } from '../util/transcript-tail.js';
import { errorMessage, log, errorFields } from '../util/log.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from './context-render.js';
import { autoSleepDue } from './sleep/auto-sleep.js';
import type { Context } from './types.js';

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
export async function closeEndedSession(ctx: Context, close: SessionClose): Promise<void> {
  if (close.sessionId) await writeEndHandoff(ctx, close.sessionId, close);
  if (close.turn) {
    close.log('skip snapshot close: turn mode');
    return;
  }
  await closeSnapshot(ctx, close.sessionId, close.log);
}

async function writeEndHandoff(ctx: Context, sessionId: string, close: SessionClose): Promise<void> {
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
async function closeSnapshot(ctx: Context, sessionId: string | null, line: (message: string) => void): Promise<void> {
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

/** The caller's hippo.db and the global one, each once; a store that is not hippo.db keeps no ledger. */
function rereadLedgers(ctx: Context): LocalFiles[] {
  const local = (ctx.reach?.hasLocal ?? true) ? ctx.store.localFiles : undefined;
  const global = ctx.reach?.global;
  const byRoot = new Map<string, LocalFiles>();
  for (const [root, files] of [
    [ctx.hippoRoot, local],
    [global?.root, global?.store.localFiles],
  ] as const) {
    if (root !== undefined && files !== undefined) byRoot.set(path.resolve(root), files);
  }
  return [...byRoot.values()];
}

/** Books the ending session's re-reads in each hippo.db its ledger rows can land in (the caller's and global); returns
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
  const lines: string[] = [];
  let tokens = 0;
  for (const { ledger } of rereadLedgers(ctx)) {
    try {
      tokens += ledger.replaceRereads(ctx.tenantId, sessionId, read.calls);
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
export async function compactResumeBlock(ctx: Context, payloadSessionId: string | null): Promise<string | null> {
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

/** What one session-end run needs from its host: the transcript, the sleep and the capture it runs, and the log it
 * writes. This module decides which store the run writes to, whether sleep runs and which turns are captured. */
export interface SessionEndWork<Turn, Scan extends { readonly turns: readonly Turn[] }> {
  mode: 'turn' | 'full';
  sessionId: string | null;
  transcriptPath: string | undefined;
  /** One line to the session-end log; `startFresh` restarts the file. */
  log: (line: string, opts?: { startFresh?: boolean }) => void;
  /** Sleeps the folder's own store; reports its own failure. */
  sleep: () => Promise<void>;
  /** Imports the session's agent notes into the global store, for a folder that does not sleep here. */
  importAgentNotes: () => void;
  readScan: (log: (line: string) => void) => Scan | null;
  /** This session's saved place in its transcript: the turns after it, and moving it past `turns`. */
  cursor: {
    after: (sessionId: string, transcriptPath: string, turns: readonly Turn[]) => readonly Turn[];
    save: (sessionId: string, transcriptPath: string, turns: readonly Turn[]) => void;
  };
  /** The project the session ran in. */
  currentProject: () => ProjectRef;
  /** Captures `turns`, or the whole transcript when undefined, into `into`; false when it failed, having said why. */
  capture: (into: Context, turns: readonly Turn[] | undefined, originProject: ProjectRef | undefined) => boolean;
  digest: (scan: Scan | null, key: string, log: (line: string) => void) => void;
  workingState: (log: (line: string) => void) => ReturnType<SessionClose['workingState']>;
  evidence: () => HandoffEvidence;
}

/** A store that is not hippo.db is its own; hippo.db's reach says whether the folder has one. */
function hasOwnStore(ctx: Context): boolean {
  return ctx.reach?.hasLocal ?? true;
}

/** The store a session's end writes to: the folder's own, else the global one; null when neither exists. */
function endStore(ctx: Context): Context | null {
  if (hasOwnStore(ctx)) return ctx;
  const global = ctx.reach?.global;
  if (global === undefined) return null;
  return {
    hippoRoot: global.root,
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    store: global.store,
    config: global.config,
  };
}

/** Sleeps the folder's own store: a reply's close only at the auto-sleep threshold, a session's end always. */
async function sleepStep<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: Context,
  w: SessionEndWork<Turn, Scan>,
): Promise<void> {
  // Sleeping the global store from here would learn this folder's git commits into it; it has its own daily sleep.
  if (!hasOwnStore(ctx)) {
    w.log('skip sleep: this folder has no store of its own', { startFresh: true });
    w.importAgentNotes();
    return;
  }
  if (w.mode !== 'turn' || !w.sessionId) return w.sleep();
  // Each line starts the log afresh, as a sleep does.
  const prefix = `turn close, session ${w.sessionId}`;
  try {
    const { enabled, count, threshold, due } = await autoSleepDue(ctx.store, ctx.tenantId, ctx.config.autoSleep);
    if (!due) {
      const why = enabled ? `${count} new memories, threshold ${threshold}` : 'auto-sleep is off';
      w.log(`${prefix}: skip sleep, ${why}`, { startFresh: true });
      return;
    }
    await w.sleep();
    w.log(`${prefix}: ran sleep at ${count} new memories (threshold ${threshold})`);
  } catch (err) {
    w.log(`${prefix}: sleep check failed: ${errorMessage(err)}`, { startFresh: true });
  }
}

/** Captures the session into `into`; a reply's close takes only the turns after the session's cursor, then moves it,
 * so each reply is extracted once. */
function captureStep<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: Context,
  into: Context,
  scan: Scan | null,
  w: SessionEndWork<Turn, Scan>,
): void {
  const capture = (turns: readonly Turn[] | undefined): boolean => {
    // With no transcript of its own, capture would read this as a manual run and scan every project.
    if (!w.transcriptPath) {
      w.log('skip capture: no transcript for this session');
      return false;
    }
    // In the global store, rows would otherwise read as user-global and show up in every project.
    return w.capture(into, turns, hasOwnStore(ctx) ? undefined : w.currentProject());
  };
  if (w.mode !== 'turn') {
    capture(scan?.turns);
    return;
  }
  if (!w.transcriptPath || !w.sessionId || !scan) {
    w.log('skip capture: no readable transcript for this session');
    return;
  }
  const fresh = w.cursor.after(w.sessionId, w.transcriptPath, scan.turns);
  if (fresh.length === 0) {
    w.log('skip capture: no new turns since the last reply');
    return;
  }
  if (capture(fresh)) w.cursor.save(w.sessionId, w.transcriptPath, scan.turns);
}

/** Books re-reads, sleeps, captures, digests and closes one ended session of the folder `ctx` names, in that order. */
export async function sessionEndWork<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: Context,
  w: SessionEndWork<Turn, Scan>,
): Promise<void> {
  const rereadLog = await bookSessionRereads(ctx, w.transcriptPath, w.sessionId).catch((err) => [
    `re-read count failed: ${errorMessage(err)}`,
  ]);
  // Sleep starts the log file afresh, so the lines go in after it; on exit too, in case sleep exits the process. A
  // flushed log drops its exit listener, so a long-lived host does not gain one per session; it stays only while lines
  // wait.
  const flushRereadLog = (): void => {
    process.off('exit', flushRereadLog);
    for (const line of rereadLog.splice(0)) w.log(line);
  };
  process.once('exit', flushRereadLog);
  // A folder with neither a project nor a global store must not get one made.
  const into = endStore(ctx);
  if (into === null) {
    w.log('skip: no hippo store for this folder or globally', { startFresh: true });
    flushRereadLog();
    return;
  }
  await sleepStep(ctx, w);
  flushRereadLog();
  const scan = w.readScan((line) => w.log(line));
  captureStep(ctx, into, scan, w);
  w.digest(scan, w.sessionId || path.basename(w.transcriptPath ?? '', '.jsonl'), (line) => w.log(line));
  // Only this session's snapshot, and only after sleep and capture.
  const closeLog = (line: string): void => w.log(line);
  await closeEndedSession(into, {
    sessionId: w.sessionId,
    turn: w.mode === 'turn',
    workingState: () => (w.transcriptPath ? w.workingState(closeLog) : null),
    evidence: w.evidence,
    log: closeLog,
  });
}
