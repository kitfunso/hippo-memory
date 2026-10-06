// A handoff's git evidence, read with no store, so a hook with no store can send it with the session's end.
import { execFileSync } from 'child_process';
import type { HandoffEvidence } from './handoff.js';

// Best-effort git state; a missing git, non-repo cwd, or the timeout all
// yield null fields rather than throw (autolearn.ts execFileSync shape).
export function collectHandoffEvidence(cwd: string, testStatus: HandoffEvidence['testStatus']): HandoffEvidence {
  let gitRef: string | null = null;
  try {
    gitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {
    // No git, not a repo, or timed out: evidence is optional, so the field stays null.
    gitRef = null;
  }
  let dirtyTree: boolean | null = null;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    dirtyTree = status.trim().length > 0;
  } catch {
    // Same as gitRef: unknown tree state is reported as null, never as an error.
    dirtyTree = null;
  }
  return { gitRef, dirtyTree, testStatus };
}
