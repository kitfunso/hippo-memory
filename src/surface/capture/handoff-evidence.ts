import { execFileSync } from 'node:child_process';
import type { HandoffEvidence } from '../../base/session/handoff.js';
import { errorCode, errorFields, errorMessage, log } from '../../base/util/log.js';

const DEFAULT_TIMEOUT_MS = 2000;

// git's exit status for a fatal error, which is what a cwd outside any repository (or a repo with
// no commit) gives.
const GIT_FATAL_STATUS = 128;

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
      log.warnThenSample(`handoff-evidence:git ${args[0]}`, message, errorFields(err));
    }
    return null;
  }
}

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
