// Windows scan locks can fail a git write under load; the runner's own retry decides what counts as transient.
import { execFileSync } from 'node:child_process';
import { retryObjectLock } from '../../scripts/token-eval/exec.mjs';

export function testGit(dir: string, ...args: string[]): string {
  return retryObjectLock(() => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}

// The caller needs one real await per git call (the test file's sync tests otherwise run as one event-loop turn) and the same scan-lock retry.
export async function testGitAsync(dir: string, ...args: string[]): Promise<string> {
  await new Promise((r) => setImmediate(r));
  return testGit(dir, ...args);
}
