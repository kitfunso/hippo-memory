// A session's end: which store it writes to, when it sleeps, which turns it captures, and the store
// writes after them (handoff, snapshot close, re-read count); plus the compact-resume read. The
// hook verbs keep stdin, spawning and the log file.

import * as path from 'node:path';
import type { HandoffEvidence } from '../base/session/handoff.js';
import type { ProjectRef } from '../base/scope/project-identity.js';
import type { SessionEvent } from '../base/ports/store/sessions.js';
import type { TranscriptCalls } from '../base/session/transcript-calls.js';
import { truncateCodePointSafe } from '../base/util/code-point-cut.js';
import { errorMessage, log, errorFields, type LineLog, type LogFields } from '../base/util/log.js';
import {
  COMPACT_RESUME_EVENT_CONTENT_CAP,
  COMPACT_RESUME_MAX_AGE_MS,
  compactResumeText,
} from './context-render.js';
import { autoSleepDue } from './sleep/auto-sleep.js';
import { newRowsOn } from './callers.js';
import { snapshotFields, type WorkingState } from '../base/session/working-state.js';
import type { Context, ContextWith } from './types.js';
import type { Ledger } from '../base/ports/store.js';

/** What closing one ended session needs from the host; the two readers run only when the handoff
 * is written. */
export interface SessionClose {
  sessionId: string | null;
  /**
   * A reply's end, not the session's: the handoff is updated in place and the snapshot stays for
   * the next compaction.
   */
  turn: boolean;
  /** The transcript's working state, or null with no readable transcript. */
  workingState: () => WorkingState | null;
  evidence: () => HandoffEvidence;
  /** One line to the session-end log. */
  log: LineLog;
}

/** Writes the session's handoff, then closes its snapshot unless `turn`; each step logs its own
 * failure and never throws. The handoff goes first, while the snapshot writeSessionEndHandoff
 * reads is still active. */
export async function closeEndedSession(
  ctx: ContextWith<'sessions'>,
  close: SessionClose,
): Promise<void> {
  if (close.sessionId) await writeEndHandoff(ctx, close.sessionId, close);
  if (close.turn) {
    close.log('skip snapshot close: turn mode');
    return;
  }
  await closeSnapshot(ctx, close.sessionId, close.log);
}

async function writeEndHandoff(
  ctx: ContextWith<'sessions'>,
  sessionId: string,
  close: SessionClose,
): Promise<void> {
  const { sessions } = ctx.store;
  try {
    const ownSnapshot =
      (await sessions.loadSnapshot(ctx.tenantId, {}, null))?.sessionId === sessionId;
    // A never-compacted session has no snapshot; read even when it has one, as another session's
    // PreCompact can take the slot before the write.
    const state = close.workingState();
    const derived = state === null ? null : snapshotFields(state);
    if (!ownSnapshot && !derived) {
      close.log('skip: no snapshot or transcript for session');
      return;
    }
    const sessionEnd = { sessionId, evidence: close.evidence(), derived, inPlace: close.turn };
    const handoff = await sessions.save(ctx.tenantId, 'handoff', { sessionEnd }, null);
    close.log(
      handoff
        ? `wrote handoff for session ${sessionId}`
        : `skip: kept the existing handoff for session ${sessionId}`,
    );
  } catch (err) {
    close.log(`handoff write failed: ${errorMessage(err)}`, { fields: errorFields(err) });
    log.error('session-end: handoff write failed', errorFields(err));
  }
}

// If session-end never fires (crash, kill -9), the freshness bound of an ambient snapshot load is
// the backstop.
async function closeSnapshot(
  ctx: ContextWith<'sessions'>,
  sessionId: string | null,
  logLine: LineLog,
): Promise<void> {
  try {
    if (sessionId) {
      const close = { status: 'session-ended', sessionId };
      const closed = await ctx.store.sessions.clear(ctx.tenantId, 'snapshot', close, null);
      logLine(`closed ${closed} active snapshot(s) for session ${sessionId}`);
    } else {
      logLine('skip: no session_id in SessionEnd payload, active snapshot left untouched');
    }
  } catch (err) {
    logLine(`snapshot close failed: ${errorMessage(err)}`, { fields: errorFields(err) });
    log.error('session-end: snapshot close failed', errorFields(err));
  }
}

/** The caller's store and the global one, each once; a store that keeps no ledger is left out. */
function rereadLedgers(ctx: Context): Ledger[] {
  const local = ctx.reach?.hasLocal === false ? undefined : ctx.reach?.ledger?.ledger;
  // A call on the global store reaches it twice, as itself and as the global store beside it.
  const global = ctx.reach?.isGlobal === true ? undefined : ctx.reach?.global?.store.ledger;
  return [local, global].filter((ledger) => ledger !== undefined);
}

/** Books the ending session's re-reads in each hippo.db its ledger rows can land in (the
 * caller's and global); returns the log lines. */
export async function bookSessionRereads(
  ctx: Context,
  transcriptPath: string | undefined,
  sessionId: string | null,
): Promise<string[]> {
  if (!transcriptPath || !sessionId) return [];
  const { transcriptCalls } = ctx.infra;
  if (transcriptCalls === undefined) {
    return ['skip re-read count: this context reads no transcripts'];
  }
  let read: TranscriptCalls;
  try {
    read = await transcriptCalls(transcriptPath);
  } catch (err) {
    log.warn('session-end: transcript not read, so its re-reads go uncounted', errorFields(err));
    return [`skip re-read count: cannot read the transcript: ${errorMessage(err)}`];
  }
  const lines: string[] = [];
  let tokens = 0;
  for (const ledger of rereadLedgers(ctx)) {
    try {
      tokens += await ledger.replaceRereads(ctx.tenantId, sessionId, read.calls);
    } catch (err) {
      log.debug('session-end: re-read count failed', errorFields(err));
      lines.push(`re-read count failed: ${errorMessage(err)}`);
    }
  }
  const skipped =
    read.malformed > 0 ? `, ${read.malformed} unparsable transcript lines skipped` : '';
  lines.push(
    `re-read ${tokens} tokens over ${read.calls.length} model calls for session ${sessionId}${skipped}`,
  );
  return lines;
}

/** The block a compaction lost: the fresh task snapshot and its session trail, or null with none
 * or another session's snapshot. */
export async function compactResumeBlock(
  ctx: ContextWith<'sessions'>,
  payloadSessionId: string | null,
): Promise<string | null> {
  const { sessions } = ctx.store;
  const ambient = { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS };
  const snapshot = await sessions.loadSnapshot(ctx.tenantId, { ambient }, null);
  // Concurrent sessions must not cross-restore: only when both ids are present and differ, so a
  // manual run with no payload id still prints.
  if (!snapshot) return null;
  if (
    payloadSessionId !== null &&
    snapshot.sessionId !== null &&
    payloadSessionId !== snapshot.sessionId
  ) {
    return null;
  }
  // A bad trail row costs the trail, not the snapshot; stderr stays out of the model's context.
  let events: SessionEvent[] = [];
  try {
    if (snapshot.sessionId) {
      events = (await sessions.read(ctx.tenantId, 'event', { sessionId: snapshot.sessionId })).map(
        (e) => ({
          ...e,
          content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
        }),
      );
    }
  } catch (err) {
    log.warn(`hippo compact-resume: trail skipped: ${errorMessage(err)}`, errorFields(err));
  }
  return compactResumeText(snapshot, events);
}

/** Log lines held until sleep has restarted the log file. Each line is written once, so the host
 * may also flush on process exit, in case a step ends the process before the run flushes. */
export interface HeldLog {
  hold(lines: readonly string[]): void;
  flush(): void;
}

export function heldLog(write: (line: string) => void): HeldLog {
  const lines: string[] = [];
  return {
    hold(more) {
      lines.push(...more);
    },
    flush() {
      for (const line of lines.splice(0)) write(line);
    },
  };
}

/** What one session-end run needs from its host: the transcript, the sleep and the capture it
 * runs, and the log it writes. This module decides which store the run writes to, whether sleep
 * runs and which turns are captured. */
export interface SessionEndWork<Turn, Scan extends { readonly turns: readonly Turn[] }> {
  mode: 'turn' | 'full';
  sessionId: string | null;
  transcriptPath: string | undefined;
  /** One line to the session-end log; `startFresh` restarts the file. */
  log: (line: string, opts?: { startFresh?: boolean; fields?: LogFields }) => void;
  /** Where the re-read count's lines wait for sleep. */
  held: HeldLog;
  /** Sleeps the folder's own store; reports its own failure. */
  sleep: () => Promise<void>;
  /** Imports the session's agent notes into the global store, for a folder that does not sleep
   * here. */
  importAgentNotes: () => Promise<void>;
  readScan: (log: LineLog) => Scan | null;
  /** This session's saved place in its transcript: the turns after it, and moving it past
   * `turns`. */
  cursor: {
    after: (sessionId: string, transcriptPath: string, turns: readonly Turn[]) => readonly Turn[];
    save: (sessionId: string, transcriptPath: string, turns: readonly Turn[]) => void;
  };
  /** The project the session ran in. */
  currentProject: () => ProjectRef;
  /** Captures `turns`, or the whole transcript when undefined, into `into`; false when it
   * failed, having said why. */
  capture: (
    into: Context,
    turns: readonly Turn[] | undefined,
    originProject: ProjectRef | undefined,
  ) => Promise<boolean>;
  digest: (scan: Scan | null, key: string, log: LineLog) => Promise<void>;
  workingState: (log: LineLog) => ReturnType<SessionClose['workingState']>;
  evidence: () => HandoffEvidence;
}

/** A store that is not hippo.db is its own; hippo.db's reach says whether the folder has one. */
function hasOwnStore(ctx: Context): boolean {
  return ctx.reach?.hasLocal ?? true;
}

/** The store a session's end writes to: the folder's own, else the global one; null when neither
 * exists. */
function endStore(ctx: ContextWith<'sessions'>): ContextWith<'sessions'> | null {
  if (hasOwnStore(ctx)) return ctx;
  const global = ctx.reach?.global;
  if (global === undefined) return null;
  return {
    tenantId: ctx.tenantId,
    actor: ctx.actor,
    store: global.store,
    config: global.config,
    infra: ctx.infra,
  };
}

/** Sleeps the folder's own store: a reply's close only at the auto-sleep threshold, a session's
 * end always. */
async function sleepStep<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: ContextWith<'sessions' | 'reports'>,
  w: SessionEndWork<Turn, Scan>,
): Promise<void> {
  // Sleeping the global store from here would learn this folder's git commits into it; it has its
  // own daily sleep.
  if (!hasOwnStore(ctx)) {
    w.log('skip sleep: this folder has no store of its own', { startFresh: true });
    await w.importAgentNotes();
    return;
  }
  if (w.mode !== 'turn' || !w.sessionId) return w.sleep();
  // Each line starts the log afresh, as a sleep does.
  const prefix = `turn close, session ${w.sessionId}`;
  try {
    const { enabled, count, threshold, due } = await autoSleepDue(
      newRowsOn(ctx.store),
      ctx.tenantId,
      ctx.config.autoSleep,
      ctx.infra.clock(),
    );
    if (!due) {
      const why = enabled ? `${count} new memories, threshold ${threshold}` : 'auto-sleep is off';
      w.log(`${prefix}: skip sleep, ${why}`, { startFresh: true });
      return;
    }
    await w.sleep();
    w.log(`${prefix}: ran sleep at ${count} new memories (threshold ${threshold})`);
  } catch (err) {
    w.log(`${prefix}: sleep check failed: ${errorMessage(err)}`, {
      startFresh: true,
      fields: errorFields(err),
    });
  }
}

/** Captures the session into `into`; a reply's close takes only the turns after the session's
 * cursor, then moves it, so each reply is extracted once. */
async function captureStep<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: Context,
  into: Context,
  scan: Scan | null,
  w: SessionEndWork<Turn, Scan>,
): Promise<void> {
  const capture = async (turns: readonly Turn[] | undefined): Promise<boolean> => {
    // With no transcript of its own, capture would read this as a manual run and scan every
    // project.
    if (!w.transcriptPath) {
      w.log('skip capture: no transcript for this session');
      return false;
    }
    // In the global store, rows would otherwise read as user-global and show up in every project.
    return w.capture(into, turns, hasOwnStore(ctx) ? undefined : w.currentProject());
  };
  if (w.mode !== 'turn') {
    await capture(scan?.turns);
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
  if (await capture(fresh)) w.cursor.save(w.sessionId, w.transcriptPath, scan.turns);
}

/** Books re-reads, sleeps, captures, digests and closes one ended session of the folder `ctx`
 * names, in that order. */
export async function sessionEndWork<Turn, Scan extends { readonly turns: readonly Turn[] }>(
  ctx: ContextWith<'sessions' | 'reports'>,
  w: SessionEndWork<Turn, Scan>,
): Promise<void> {
  const rereadLog = await bookSessionRereads(ctx, w.transcriptPath, w.sessionId).catch((err) => {
    log.warn(`session-end: re-read count failed: ${errorMessage(err)}`, errorFields(err));
    return [`re-read count failed: ${errorMessage(err)}`];
  });
  // Sleep starts the log file afresh, so the lines go in after it.
  w.held.hold(rereadLog);
  // A folder with neither a project nor a global store must not get one made.
  const into = endStore(ctx);
  try {
    if (into === null) {
      w.log('skip: no hippo store for this folder or globally', { startFresh: true });
      return;
    }
    await sleepStep(ctx, w);
  } finally {
    w.held.flush();
  }
  const scan = w.readScan((line, opts) => w.log(line, opts));
  await captureStep(ctx, into, scan, w);
  await w.digest(
    scan,
    w.sessionId || path.basename(w.transcriptPath ?? '', '.jsonl'),
    (line, opts) => w.log(line, opts),
  );
  // Only this session's snapshot, and only after sleep and capture.
  const closeLog: LineLog = (line, opts) => w.log(line, opts);
  await closeEndedSession(into, {
    sessionId: w.sessionId,
    turn: w.mode === 'turn',
    workingState: () => (w.transcriptPath ? w.workingState(closeLog) : null),
    evidence: w.evidence,
    log: closeLog,
  });
}
