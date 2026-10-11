// The store writes a session's end makes after sleep and capture (handoff, snapshot close, re-read count), and the
// compact-resume read; the hook verbs keep stdin, spawning and the log file.

import * as path from 'path';
import type { HandoffEvidence } from '../core/handoff.js';
import { isInitialized } from '../core/project-identity.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import { closeTaskSnapshotsForSession, listSessionEvents, loadActiveTaskSnapshot, loadFreshActiveTaskSnapshot } from '../store/sessions.js';
import { writeSessionEndHandoff } from '../store/handoffs.js';
import { readApiCalls, recordRereads, type TranscriptCalls } from '../store/token-ledger.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { truncateCodePointSafe } from '../util/transcript-tail.js';
import { errorMessage, log } from '../util/log.js';
import { COMPACT_RESUME_EVENT_CONTENT_CAP, COMPACT_RESUME_MAX_AGE_MS, compactResumeText } from './context-render.js';
import type { Context } from './types.js';

/** What closing one ended session needs from the host; the two readers run only when the handoff is written. */
export interface SessionClose {
  sessionId: string | null;
  /** A reply's end, not the session's: the handoff is updated in place and the snapshot stays for the next compaction. */
  turn: boolean;
  /** The transcript's working state, or null with no readable transcript. */
  workingState: () => Pick<TaskSnapshot, 'task' | 'summary' | 'next_step'> | null;
  evidence: () => HandoffEvidence;
  /** One line to the session-end log. */
  log: (line: string) => void;
}

/** Writes the session's handoff, then closes its snapshot unless `turn`; each step logs its own failure and never throws.
 *  The handoff goes first, while the snapshot writeSessionEndHandoff reads is still active. */
export function closeEndedSession(ctx: Context, close: SessionClose): void {
  if (close.sessionId) writeEndHandoff(ctx, close.sessionId, close);
  if (close.turn) {
    close.log('skip snapshot close: turn mode');
    return;
  }
  closeSnapshot(ctx, close.sessionId, close.log);
}

function writeEndHandoff(ctx: Context, sessionId: string, close: SessionClose): void {
  try {
    const ownSnapshot = loadActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId)?.session_id === sessionId;
    // A never-compacted session has no snapshot; read even when it has one, as another session's PreCompact can take the slot before the write.
    const derived = close.workingState();
    if (!ownSnapshot && !derived) {
      close.log('skip: no snapshot or transcript for session');
      return;
    }
    const handoff = writeSessionEndHandoff(ctx.hippoRoot, ctx.tenantId, sessionId, close.evidence(), derived, undefined, { inPlace: close.turn });
    close.log(handoff ? `wrote handoff for session ${sessionId}` : `skip: kept the existing handoff for session ${sessionId}`);
  } catch (err) {
    close.log(`handoff write failed: ${errorMessage(err)}`);
  }
}

// If session-end never fires (crash, kill -9), the freshness bound in loadFreshActiveTaskSnapshot is the backstop.
function closeSnapshot(ctx: Context, sessionId: string | null, line: (message: string) => void): void {
  try {
    if (sessionId) {
      const closed = closeTaskSnapshotsForSession(ctx.hippoRoot, ctx.tenantId, sessionId);
      line(`closed ${closed} active snapshot(s) for session ${sessionId}`);
    } else {
      line('skip: no session_id in SessionEnd payload, active snapshot left untouched');
    }
  } catch (err) {
    line(`snapshot close failed: ${errorMessage(err)}`);
  }
}

/** Books the ending session's re-reads in each store its ledger rows can land in (`ctx.hippoRoot` and global); returns the log lines. */
export async function bookSessionRereads(ctx: Context, transcriptPath: string | undefined, sessionId: string | null): Promise<string[]> {
  if (!transcriptPath || !sessionId) return [];
  let read: TranscriptCalls;
  try {
    read = await readApiCalls(transcriptPath);
  } catch (err) {
    return [`skip re-read count: cannot read the transcript: ${errorMessage(err)}`];
  }
  const roots = new Set([ctx.hippoRoot, getGlobalRoot()].filter((root) => isInitialized(root)).map((root) => path.resolve(root)));
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

/** The block a compaction lost: the fresh task snapshot and its session trail, or null with none or another session's snapshot. */
export function compactResumeBlock(ctx: Context, payloadSessionId: string | null): string | null {
  const snapshot = loadFreshActiveTaskSnapshot(ctx.hippoRoot, ctx.tenantId, { maxAgeMs: COMPACT_RESUME_MAX_AGE_MS });
  // Concurrent sessions must not cross-restore: only when both ids are present and differ, so a manual run with no payload id still prints.
  if (!snapshot || (payloadSessionId !== null && snapshot.session_id !== null && payloadSessionId !== snapshot.session_id)) return null;
  // A bad trail row costs the trail, not the snapshot; stderr stays out of the model's context.
  let events: SessionEvent[] = [];
  try {
    if (snapshot.session_id) {
      events = listSessionEvents(ctx.hippoRoot, ctx.tenantId, { session_id: snapshot.session_id }).map((e) => ({
        ...e,
        content: truncateCodePointSafe(e.content, COMPACT_RESUME_EVENT_CONTENT_CAP),
      }));
    }
  } catch (err) {
    log.warn(`hippo compact-resume: trail skipped: ${errorMessage(err)}`);
  }
  return compactResumeText(snapshot, events);
}
