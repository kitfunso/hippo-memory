// A handoff's git evidence, read with no store, so a hook with no store can send it with the session's end.
import { execFileSync } from 'child_process';
import type { HandoffEvidence } from './handoff.js';

// Best-effort git state; a missing git, non-repo cwd, or a call past timeoutMs (each call, default 2 s)
// yields null fields rather than throw, so a hook with a hard deadline can cap a slow repo.
export function collectHandoffEvidence(
  cwd: string,
  testStatus: HandoffEvidence['testStatus'],
  options: { timeoutMs?: number } = {},
): HandoffEvidence {
  const timeoutMs = options.timeoutMs ?? 2000;
  let gitRef: string | null = null;
  try {
    gitRef = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {
    // No git, not a repo, or timed out: evidence is optional, so the field stays null.
    gitRef = null;
  }
  let dirtyTree: boolean | null = null;
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    dirtyTree = status.trim().length > 0;
  } catch {
    // Same as gitRef: unknown tree state is reported as null, never as an error.
    dirtyTree = null;
  }
  return { gitRef, dirtyTree, testStatus };
}
