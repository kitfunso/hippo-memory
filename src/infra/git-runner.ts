import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import type { GitCall, GitRunner } from '../base/ports/git.js';
import { errorMessage } from '../base/util/log.js';

const STDIO = { drop: ['ignore', 'pipe', 'ignore'], keep: ['pipe', 'pipe', 'pipe'] } as const;

function optionalOptions(call: GitCall): ExecFileSyncOptions {
  const options: ExecFileSyncOptions = {};
  // Keys stay absent rather than undefined: an undefined maxBuffer would lift node's default cap.
  if (call.cwd !== undefined) options.cwd = call.cwd;
  if (call.maxBuffer !== undefined) options.maxBuffer = call.maxBuffer;
  if (call.stderr !== undefined) options.stdio = [...STDIO[call.stderr]];
  if (call.input !== undefined) options.input = call.input;
  return options;
}

function exitStatus(error: Error): number | null {
  if (!('status' in error)) return null;
  const { status } = error;
  return Number.isInteger(status) ? Number(status) : null;
}

/** git as a child process with no shell; a failure returns node's own error, so its message
 * names git's stderr. */
export const processGit: GitRunner = {
  run(args, call) {
    try {
      return {
        ok: true,
        stdout: execFileSync('git', args, {
          ...optionalOptions(call),
          encoding: 'utf8',
          timeout: call.timeoutMs,
          windowsHide: true,
        }),
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(errorMessage(err));
      return { ok: false, status: exitStatus(error), error };
    }
  },
};
