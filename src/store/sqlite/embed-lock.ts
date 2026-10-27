// The embedding index's write lock beside hippo.db: a file lock every process on the folder honours,
// freed by the operating system when its holder dies.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { errorCode } from '../../base/util/log.js';
import { takeFileLock, type FileLock } from '../../host/file-lock.js';

const EMBED_LOCK_FILE = 'embeddings.lock.db';

/** The folder's identity in this process: two handles on one hippo.db share it, whatever link or
 * letter case names the folder. */
export function embedLockKey(hippoRoot: string): string {
  const real = realFolder(path.resolve(hippoRoot));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function realFolder(folder: string): string {
  try {
    return fs.realpathSync.native(folder);
  } catch (error) {
    // A folder not made yet has no link to follow; its first open makes it under this name.
    if (errorCode(error) === 'ENOENT') return folder;
    throw error;
  }
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
