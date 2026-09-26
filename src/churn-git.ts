/** Git subprocess helpers for FE2 churn-staleness (src/invalidation.ts). */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A `git log --name-status` dump can run to tens of MB; default 1MB pipe would truncate it.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** A real git failure (not git grep's expected exit-1-no-match). Callers abort the whole run on this. */
export class GitReadError extends Error {}

function runGit(args: string[], repoRoot: string): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  } catch (err) {
    throw new GitReadError(`git ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// git grep exits 1 for "no match" -- a normal empty result, not a failure.
function runGitGrepOrEmpty(args: string[], repoRoot: string): string {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER });
  } catch (err) {
    // SAFETY: execFileSync attaches `status` to the thrown Error on a non-zero child exit.
    const status = (err as { status?: number }).status;
    if (status === 1) return '';
    throw new GitReadError(`git ${args.join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function gitLsFilesAtHead(repoRoot: string): Set<string> {
  const raw = runGit(['ls-files'], repoRoot);
  return new Set(raw.split('\n').map((l) => l.trim()).filter(Boolean));
}

export interface ChurnCommitFile {
  status: string;
  path: string;
}

export interface ChurnCommit {
  hash: string;
  date: string; // committer date, ISO 8601
  files: ChurnCommitFile[];
}

// 1-day buffer guards against git's --since boundary excluding a commit dated exactly at the anchor.
export function fetchChurnWindowLog(repoRoot: string, sinceIso: string): ChurnCommit[] {
  const buffered = new Date(new Date(sinceIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
  const raw = runGit(
    ['log', '--no-renames', `--since=${buffered}`, '--pretty=format:%x01%H%x02%cI', '--name-status'],
    repoRoot,
  );
  const commits: ChurnCommit[] = [];
  let current: ChurnCommit | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('\x01')) {
      const [hash, date] = line.slice(1).split('\x02');
      current = { hash, date, files: [] };
      commits.push(current);
    } else if (current && line.trim()) {
      const m = line.match(/^([AMD])\s+(.+)$/);
      if (m) current.files.push({ status: m[1], path: m[2] });
    }
  }
  return commits;
}

/** `git grep -o -h -w -F -f <patternFile> <rev>`; returns the subset of `patterns` found. */
export function gitGrepPresence(repoRoot: string, patterns: string[], rev: string): Set<string> {
  if (patterns.length === 0) return new Set();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-churn-grep-'));
  try {
    const patternFile = path.join(tmpDir, 'patterns.txt');
    fs.writeFileSync(patternFile, `${patterns.join('\n')}\n`, 'utf8');
    const raw = runGitGrepOrEmpty(['grep', '-o', '-h', '-w', '-F', '-f', patternFile, rev], repoRoot);
    const patternSet = new Set(patterns);
    const found = new Set<string>();
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (patternSet.has(t)) found.add(t);
    }
    return found;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Last commit at or before `beforeIso`, or null when the repo has none. */
export function resolveCommitBefore(repoRoot: string, beforeIso: string): string | null {
  const raw = runGit(['rev-list', '-1', `--before=${beforeIso}`, 'HEAD'], repoRoot).trim();
  return raw === '' ? null : raw;
}

/** package.json `scripts` at a revision; null when missing/unparsable there (routine for an old commit). Git failures throw GitReadError. */
export function packageScriptsAt(repoRoot: string, rev: string): Record<string, string> | null {
  if (runGit(['ls-tree', '--name-only', rev, '--', 'package.json'], repoRoot).trim() === '') return null;
  const raw = runGit(['show', `${rev}:package.json`], repoRoot);
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // SAFETY: checked non-null object above; a non-object `scripts` just yields no script hits.
    return (parsed as { scripts?: Record<string, string> }).scripts ?? {};
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
