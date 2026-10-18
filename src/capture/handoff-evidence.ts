// A handoff's git evidence, read with no store, so a hook with no store can send it with the session's end.
import { execFileSync } from 'child_process';
import type { HandoffEvidence } from '../core/handoff.js';
import { errorCode, errorFields, errorMessage, log } from '../util/log.js';

const DEFAULT_TIMEOUT_MS = 2000;

// git's exit status for a fatal error, which is what a cwd outside any repository (or a repo with no commit) gives.
const GIT_FATAL_STATUS = 128;

/** git's stdout, or null when it has none to give; only a failure other than "not a repository" is logged, once. */
function gitOutput(args: readonly string[], cwd: string, timeoutMs: number): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch (err) {
    const notARepo = err instanceof Error && 'status' in err && err.status === GIT_FATAL_STATUS;
    if (!notARepo) {
      const message = `git ${args.join(' ')} failed (${errorCode(err) || 'no code'}): ${errorMessage(err)}`;
      log.once(`handoff-evidence:git ${args[0]}`, 'warn', message, errorFields(err));
    }
    return null;
  }
}

// Best-effort git state; a missing git, non-repo cwd, or a call past timeoutMs (each call, default 2 s)
// yields null fields rather than throw, so a hook with a hard deadline can cap a slow repo.
export function collectHandoffEvidence(
  cwd: string,
  testStatus: HandoffEvidence['testStatus'],
  options: { timeoutMs?: number } = {},
): HandoffEvidence {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const gitRef = gitOutput(['rev-parse', 'HEAD'], cwd, timeoutMs)?.trim() || null;
  const status = gitOutput(['status', '--porcelain'], cwd, timeoutMs);
  return { gitRef, dirtyTree: status === null ? null : status.trim().length > 0, testStatus };
}
