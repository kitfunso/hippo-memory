// The git layout of a project root, which Claude Code, Gemini and Copilot use to name a project's memory folder.
import { spawnSync } from 'node:child_process';

export interface GitLayout {
  readonly top: string;
  readonly gitDir: string;
  readonly common: string;
}

/** Null outside a repository or when git fails; a missing folder name then only means fewer containers listed. */
export function gitLayout(projectRoot: string): GitLayout | null {
  const git = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    { cwd: projectRoot, encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  if (git.status !== 0) return null;
  const [top, gitDir, common] = git.stdout.trim().split(/\r?\n/);
  return top && gitDir && common ? { top, gitDir, common } : null;
}
