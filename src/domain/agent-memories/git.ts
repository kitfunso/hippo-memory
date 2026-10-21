// The git layout of a project root, which Claude Code, Gemini and Copilot use to name a project's memory folder.
import type { GitRunner } from '../../base/ports/git.js';
import { GIT_CALL_TIMEOUT_MS } from '../../base/util/time.js';

export interface GitLayout {
  readonly top: string;
  readonly gitDir: string;
  readonly common: string;
}

const LAYOUT_ARGS = [
  'rev-parse',
  '--path-format=absolute',
  '--show-toplevel',
  '--absolute-git-dir',
  '--git-common-dir',
];

/** Null outside a repository or when git fails; a missing folder name then only means fewer containers listed. */
export function gitLayout(git: GitRunner, projectRoot: string): GitLayout | null {
  const run = git.run(LAYOUT_ARGS, { cwd: projectRoot, timeoutMs: GIT_CALL_TIMEOUT_MS, stderr: 'keep' });
  if (!run.ok) return null;
  const [top, gitDir, common] = run.stdout.trim().split(/\r?\n/);
  return top && gitDir && common ? { top, gitDir, common } : null;
}
