// The embedding index's write lock beside hippo.db: an O_EXCL "<pid>:<token>" file that every process on the folder
// honours. Our token is a lock we leaked; our PID with another token is a live worker thread, unless the lock
// predates this process (a reused PID).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const EMBED_LOCK_FILE = 'embeddings.lock';
const EMBED_LOCK_OWNER = `${process.pid}:${randomUUID()}`;

function hasCode<E>(err: E, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code;
}

function holderAlive(lockPath: string): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return !hasCode(err, 'ENOENT');
  }
  const mtimeMs = fs.statSync(lockPath, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  const pid = Number(raw.split(':')[0]);
  // An empty lock is a holder between create and write; after 5 s it is a crashed one.
  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - mtimeMs < 5_000;
  if (raw === EMBED_LOCK_OWNER) return false;
  if (pid === process.pid) return mtimeMs >= Date.now() - process.uptime() * 1000;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return hasCode(err, 'EPERM');
  }
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
      if (!hasCode(err, 'EEXIST')) throw err;
    }
    if (holderAlive(lockPath)) return null;
    // SHORTCUT: two waiters can both break one dead holder's lock; a vector lost that way is backfilled by the next
    // `hippo embed`.
    fs.rmSync(lockPath, { force: true });
  }
}

/** After the double-break race above the file can be another writer's lock, so only `token`'s own is removed. */
export function releaseEmbedLock(hippoRoot: string, token: string): void {
  const lockPath = path.join(hippoRoot, EMBED_LOCK_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (hasCode(err, 'ENOENT')) return;
    throw err;
  }
  if (raw === token) fs.rmSync(lockPath, { force: true });
}
