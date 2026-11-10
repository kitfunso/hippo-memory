// A sleep's claim on the store: a file lock beside hippo.db that every process on the folder honours,
// freed by the operating system when its holder dies, so no age or pid check can break a live sleep.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeFileLock, type FileLock } from '../../../host/file-lock.js';
import type { Consolidation, SleepClaim } from '../../../base/ports/store/consolidation.js';
import { errorFields, errorMessage, log } from '../../../base/util/log.js';
import { answered } from '../runtime/bound.js';

const SLEEP_LOCK_FILE = 'sleep.lock.db';

// A folder that cannot keep a lock warns once for the process, not once per sleep.
const warnedRoots = new Set<string>();

/** When the holder took the claim: the mtime it stamped on the lock file. */
function claimedSince(file: string): string {
  // A file gone under a live holder, or one that cannot be read, has no stamp left, so the time is now.
  try {
    return (fs.statSync(file, { throwIfNoEntry: false })?.mtime ?? new Date()).toISOString();
  } catch (err) {
    log.warn(
      `the sleep claim on ${file} could not be read: ${errorMessage(err)}`,
      errorFields(err),
    );
    return new Date().toISOString();
  }
}

// By path, never by descriptor: a descriptor closed here would drop this process's other locks.
function stamp(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch (err) {
    log.warn(
      `the sleep claim on ${file} was not stamped, so a refused sleep may name an older time: ` +
        errorMessage(err),
      errorFields(err),
    );
  }
}

function warnUnusable(hippoRoot: string, cause: unknown): void {
  if (warnedRoots.has(hippoRoot)) return;
  warnedRoots.add(hippoRoot);
  log.warn(
    `the sleep claim could not be taken on ${hippoRoot}, so sleeps there run unguarded: ` +
      errorMessage(cause),
    errorFields(cause),
  );
}

/** The claim members of the folder's Consolidation group; the closure keeps the lock its sleep holds. */
export function sleepClaim(
  hippoRoot: string,
): Required<Pick<Consolidation, 'claimSleep' | 'releaseSleep'>> {
  // Joined at the claim, so a store built on a root that is no path still opens.
  const lockFile = (): string => path.join(hippoRoot, SLEEP_LOCK_FILE);
  let held: FileLock | null = null;
  return {
    claimSleep: () =>
      answered((): SleepClaim => {
        const file = lockFile();
        const take = takeFileLock(file);
        if (take.kind === 'held') return { kind: 'held', since: claimedSince(file) };
        if (take.kind === 'unusable') {
          warnUnusable(hippoRoot, take.cause);
          return { kind: 'taken' };
        }
        held = take.lock;
        stamp(file);
        return { kind: 'taken' };
      }),
    releaseSleep: () =>
      answered(() => {
        try {
          held?.release();
        } finally {
          held = null;
        }
      }),
  };
}
