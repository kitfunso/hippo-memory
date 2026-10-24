// The embedding index's write lock beside hippo.db: an O_EXCL "<pid>:<token>" file that every process on the folder
// honours. Our token is a lock we leaked; our PID with another token is a live worker thread, unless the lock
// predates this process (a reused PID).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { errorCode } from '../../base/util/log.js';
import { holderAlive } from '../../host/pid-alive.js';

const EMBED_LOCK_FILE = 'embeddings.lock';
// A breaker file older than this belongs to a waiter that died mid-break.
const BREAKER_STALE_MS = 5_000;
const EMBED_LOCK_OWNER = `${process.pid}:${randomUUID()}`;

/** The folder's identity in this process: two handles on one hippo.db share it. */
export function embedLockKey(hippoRoot: string): string {
  const resolved = path.resolve(hippoRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function lockHeld(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return errorCode(err) !== 'ENOENT';
  }
  const mtimeMs = fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const pid = Number(raw.split(':')[0]);
  // An empty lock is a holder between create and write; after 5 s it is a crashed one.
  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - mtimeMs < 5_000;
  if (raw === EMBED_LOCK_OWNER) return false;
  return holderAlive(pid, () => mtimeMs >= Date.now() - process.uptime() * 1000);
}

/** Takes the lock under `hippoRoot`, breaking a dead holder's; the token to unlock with, or null while a live holder
 * has it. */
export function tryEmbedLock(hippoRoot: string): string | null {
  const lockPath = path.join(hippoRoot, EMBED_LOCK_FILE);
  for (;;) {
    try {
      fs.writeFileSync(lockPath, EMBED_LOCK_OWNER, { flag: 'wx' });
      return EMBED_LOCK_OWNER;
    } catch (err) {
      if (errorCode(err) !== 'EEXIST') throw err;
    }
    if (lockHeld(lockPath) || !breakStaleLock(lockPath)) return null;
  }
}

/** Only the waiter that creates the breaker file removes the dead holder's lock, and it re-reads the holder first: a
 * waiter that lost the race sees a lock another waiter has just retaken and leaves it. */
function breakStaleLock(lockPath: string): boolean {
  const breaker = `${lockPath}.breaker`;
  try {
    fs.writeFileSync(breaker, EMBED_LOCK_OWNER, { flag: 'wx' });
  } catch (err) {
    if (errorCode(err) !== 'EEXIST') throw err;
    const mtimeMs = fs.statSync(breaker, { throwIfNoEntry: false })?.mtimeMs ?? Date.now();
    if (Date.now() - mtimeMs >= BREAKER_STALE_MS) fs.rmSync(breaker, { force: true });
    return false;
  }
  try {
    if (!lockHeld(lockPath)) fs.rmSync(lockPath, { force: true });
  } finally {
    fs.rmSync(breaker, { force: true });
  }
  return true;
}

/** The file can be another writer's lock by now, so only `token`'s own is removed. */
export function releaseEmbedLock(hippoRoot: string, token: string): void {
  const lockPath = path.join(hippoRoot, EMBED_LOCK_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return;
    throw err;
  }
  if (raw === token) fs.rmSync(lockPath, { force: true });
}
