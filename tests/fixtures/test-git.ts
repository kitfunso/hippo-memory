// Windows scan locks can fail a git write under load; the runner's own retry decides what counts as transient.
import { execFileSync } from 'node:child_process';
import { retryObjectLock } from '../../scripts/token-eval/exec.mjs';

export function testGit(dir: string, ...args: string[]): string {
  return retryObjectLock(() => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
}
