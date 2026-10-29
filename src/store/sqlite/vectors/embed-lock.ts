// The embedding index's write lock beside hippo.db: a file lock every process on the folder honours,
// freed by the operating system when its holder dies.
import * as path from 'node:path';
import { realpathOfNearest } from '../../../host/real-path.js';
import { takeFileLock, type FileLock } from '../../../host/file-lock.js';

const EMBED_LOCK_FILE = 'embeddings.lock.db';

/** The folder's identity in this process: two handles on one hippo.db share it, whatever link or
 * letter case names the folder, and before or after the folder is made. */
export function embedLockKey(hippoRoot: string): string {
  const real = realpathOfNearest(hippoRoot);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/** Takes the lock under `hippoRoot`; null while a live holder has it. Throws when the lock file
 * cannot be made. */
export function tryEmbedLock(hippoRoot: string): FileLock | null {
  const take = takeFileLock(path.join(hippoRoot, EMBED_LOCK_FILE));
  if (take.kind === 'unusable') {
    throw take.cause instanceof Error ? take.cause : new Error(String(take.cause));
  }
  return take.kind === 'taken' ? take.lock : null;
}
