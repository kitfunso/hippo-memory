// One session-end worker per session at a time, plus how far turn capture has read that session's transcript.
// Two fast replies would otherwise start two workers that both read the dedupe keys before either writes.
import * as fs from 'fs';
import * as path from 'path';
import { homeDir } from '../util/agent-homes.js';
import { errorMessage, log as logger } from '../util/log.js';
import { isObjectLike, isStringValue, type ProgressCursor } from '../core/capture-contract.js';
import { SESSION_ID_RE } from './copilot-transcript.js';
import type { SessionTurn } from './transcript.js';
import { blockHash } from '../util/token-text.js';

/** A turn close runs after each reply; a full close runs once, when the session ends. */
export type WorkerMode = 'turn' | 'full';

interface SessionStateFiles {
  readonly lock: string;
  readonly queued: string;
  readonly cursor: string;
}

/** Null for a missing id or one that could climb out of the sessions folder. */
function sessionStateFiles(sessionId: string | null): SessionStateFiles | null {
  if (sessionId === null || !SESSION_ID_RE.test(sessionId)) return null;
  const base = path.join(homeDir(), '.hippo', 'sessions', sessionId);
  return { lock: `${base}.lock`, queued: `${base}.queued`, cursor: `${base}.cursor.json` };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/** Windows reuses pids, so past this a lock is stale whatever process it names; a worker rarely waits more than minutes on a busy store. */
const STALE_LOCK_MS = 15 * 60 * 1000;

/** A dead holder frees its session at once, and any holder at STALE_LOCK_MS. */
function holderAlive(lock: string): boolean {
  let text: string;
  let mtimeMs: number;
  try {
    text = fs.readFileSync(lock, 'utf8');
    mtimeMs = fs.statSync(lock).mtimeMs;
  } catch (err) {
    // Gone means released; any other read error is taken as held, so two workers never run on a guess.
    return !(err instanceof Error && 'code' in err && err.code === 'ENOENT');
  }
  const held = /^(\d+):(\d+)$/.exec(text.trim());
  if (Date.now() - (held ? Number(held[2]) : mtimeMs) > STALE_LOCK_MS) return false;
  // Empty or torn: its taker is between the create and the write, so it is held.
  if (!held) return true;
  const pid = Number(held[1]);
  return pid !== process.pid && pidAlive(pid);
}

type Take = 'taken' | 'held' | 'unusable';

// SHORTCUT: two takers racing one stale-lock cleanup can both run, as every worker did before the lock; an atomic link-based take if that shows up.
function takeSessionLock(lock: string): Take {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lock, `${process.pid}:${Date.now()}`, { flag: 'wx' });
      return 'taken';
    } catch (err) {
      if (!(err instanceof Error && 'code' in err && err.code === 'EEXIST')) return 'unusable';
      if (holderAlive(lock)) return 'held';
    }
    try {
      fs.rmSync(lock, { force: true });
    } catch {
      return 'unusable';
    }
  }
  return 'held';
}

function releaseSessionLock(lock: string): void {
  try {
    fs.rmSync(lock, { force: true });
  } catch (err) {
    // A lock left behind names this pid, which is dead once the worker exits, so the next taker clears it.
    logger.debug(`session lock not removed: ${errorMessage(err)}`);
  }
}

/** False when the sessions folder cannot be written, so the caller runs unlocked as before. */
function queueRun(files: SessionStateFiles, mode: WorkerMode): boolean {
  try {
    fs.mkdirSync(path.dirname(files.queued), { recursive: true });
    // A full close outranks a turn close: it overwrites a queued turn, and a turn never replaces a queued full close.
    if (mode === 'full') fs.writeFileSync(files.queued, 'full');
    else fs.writeFileSync(files.queued, 'turn', { flag: 'wx' });
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EEXIST';
  }
}

/** Takes the queued request by renaming it, so one queued while this reads it lands in a fresh file. */
function takeQueued(queued: string): WorkerMode | null {
  const taken = `${queued}.${process.pid}`;
  try {
    fs.renameSync(queued, taken);
  } catch {
    // Nothing queued, or a rename refused for a moment; the request stays queued for the next round.
    return null;
  }
  try {
    return fs.readFileSync(taken, 'utf8') === 'full' ? 'full' : 'turn';
  } finally {
    fs.rmSync(taken, { force: true });
  }
}

/** Runs `work` unless a live worker holds this session, which then runs the request after its own so the last reply is never dropped. */
export async function runSessionWorker(sessionId: string | null, mode: WorkerMode, work: (mode: WorkerMode) => Promise<void>): Promise<void> {
  const files = sessionStateFiles(sessionId);
  if (files === null || !queueRun(files, mode)) return work(mode);
  for (let take = takeSessionLock(files.lock); take !== 'held'; take = takeSessionLock(files.lock)) {
    if (take === 'unusable') return work(mode);
    let ran = false;
    try {
      for (let next = takeQueued(files.queued); next !== null; next = takeQueued(files.queued)) {
        ran = true;
        await work(next);
      }
    } finally {
      releaseSessionLock(files.lock);
    }
    // A request queued after the last take found the lock still held and left, so it runs here.
    if (!ran || !fs.existsSync(files.queued)) return;
  }
}

function turnKey(turn: SessionTurn): string {
  return blockHash(`${turn.role}\n${turn.text}`);
}

/** The cursor position after `turns`: how many there were and a hash of the last. */
export function turnPosition(turns: readonly SessionTurn[]): string {
  return turns.length === 0 ? '0:' : `${turns.length}:${turnKey(turns[turns.length - 1])}`;
}

/** The turns after `position`; all of them when it is null or its last turn is no longer in view. */
export function turnsAfter(turns: readonly SessionTurn[], position: string | null): readonly SessionTurn[] {
  if (position === null) return turns;
  const [countText, key] = position.split(':');
  const count = Number(countText);
  if (!Number.isInteger(count) || count <= 0) return turns;
  if (count <= turns.length && turnKey(turns[count - 1]) === key) return turns.slice(count);
  // A transcript too big to read whole is read from its tail, so the count shifts; the last turn's text still marks the place.
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turnKey(turns[i]) === key) return turns.slice(i + 1);
  }
  return turns;
}

/** The saved position for this session's transcript; null when none was saved, it names another file, or it is unreadable. */
export function loadTurnPosition(sessionId: string, transcriptPath: string): string | null {
  const file = sessionStateFiles(sessionId)?.cursor;
  if (!file || !fs.existsSync(file)) return null;
  try {
    const cursor: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObjectLike(cursor) || !('source' in cursor) || cursor.source !== transcriptPath) return null;
    return 'position' in cursor && isStringValue(cursor.position) ? cursor.position : null;
  } catch {
    // A torn cursor means the next capture reads every turn, which the dedupe keys absorb.
    return null;
  }
}

// SHORTCUT: one small cursor file per chat is never pruned; prune by age at sleep if the folder grows.
export function saveTurnPosition(sessionId: string, transcriptPath: string, turns: readonly SessionTurn[], log: (message: string) => void): void {
  const file = sessionStateFiles(sessionId)?.cursor;
  if (!file) return;
  const cursor: ProgressCursor = {
    runtime: 'vscode', sessionId, source: transcriptPath, position: turnPosition(turns), updatedAt: new Date().toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cursor));
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows refuses the rename (EPERM) while another process has the cursor open; the next reply re-reads these turns, which the dedupe keys absorb.
    log(`cursor not saved: ${errorMessage(err)}`);
  }
}
