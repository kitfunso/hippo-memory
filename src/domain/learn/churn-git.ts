/** Git reads for churn-staleness (src/domain/learn/invalidation.ts), through the caller's git runner. */

import type { GitResult, GitRunner } from '../../base/util/git-runner.js';
import { DAY_MS, MINUTE_MS } from '../../base/util/time.js';
import { errorMessage } from '../../base/util/log.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../base/util/json.js';

// A `git log --name-status` dump can run to tens of MB; default 1MB pipe would truncate it.
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
// Longer than the 10 s of one-line git reads because a full log dump on a large repo is slow, yet bounded so a wedged
// git cannot stall sleep.
const GIT_TIMEOUT_MS = MINUTE_MS;

/** A real git failure (not git grep's expected exit-1-no-match). Callers abort the whole run on this. */
export class GitReadError extends Error {}

/** The work tree churn checks read and the runner that starts git there. */
export interface ChurnRepo {
  readonly root: string;
  readonly git: GitRunner;
}

function gitCall(repo: ChurnRepo, args: string[], input?: string): GitResult {
  const call = { cwd: repo.root, maxBuffer: GIT_MAX_BUFFER, timeoutMs: GIT_TIMEOUT_MS };
  return repo.git.run(args, input === undefined ? call : { ...call, input });
}

function readFailed(args: string[], run: Extract<GitResult, { ok: false }>): GitReadError {
  return new GitReadError(`git ${args.join(' ')} failed: ${errorMessage(run.error)}`, { cause: run.error });
}

function runGit(args: string[], repo: ChurnRepo): string {
  const run = gitCall(repo, args);
  if (run.ok) return run.stdout;
  throw readFailed(args, run);
}

// git grep exits 1 for "no match" -- a normal empty result, not a failure.
function runGitGrepOrEmpty(args: string[], repo: ChurnRepo, input: string): string {
  const run = gitCall(repo, args, input);
  if (run.ok) return run.stdout;
  if (run.status === 1) return '';
  throw readFailed(args, run);
}

// ls-tree, not ls-files: the index can hold staged adds/deletes that HEAD does not.
export function gitLsFilesAtHead(repo: ChurnRepo): Set<string> {
  const raw = runGit(['ls-tree', '-r', '--name-only', 'HEAD'], repo);
  return new Set(
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
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
export function fetchChurnWindowLog(repo: ChurnRepo, sinceIso: string): ChurnCommit[] {
  const buffered = new Date(new Date(sinceIso).getTime() - DAY_MS).toISOString();
  const raw = runGit(
    // --first-parent -m: a merge's changes land as one diff against its mainline parent.
    [
      'log',
      '--no-renames',
      '--first-parent',
      '-m',
      `--since=${buffered}`,
      '--pretty=format:%x01%H%x02%cI',
      '--name-status',
    ],
    repo,
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

/** `git grep -o -h -w -F -f - <rev>` with the patterns on stdin; returns the subset of `patterns` found. */
export function gitGrepPresence(repo: ChurnRepo, patterns: string[], rev: string): Set<string> {
  if (patterns.length === 0) return new Set();
  const input = `${patterns.join('\n')}\n`;
  const raw = runGitGrepOrEmpty(['grep', '-o', '-h', '-w', '-F', '-f', '-', rev], repo, input);
  const patternSet = new Set(patterns);
  const found = new Set<string>();
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (patternSet.has(t)) found.add(t);
  }
  return found;
}

/** Last commit at or before `beforeIso`, or null when the repo has none. */
export function resolveCommitBefore(repo: ChurnRepo, beforeIso: string): string | null {
  const raw = runGit(['rev-list', '-1', '--first-parent', `--before=${beforeIso}`, 'HEAD'], repo).trim();
  return raw === '' ? null : raw;
}

/**
 * package.json `scripts` at a revision; {} when the file is absent, null when unparsable. Git failures throw
 * GitReadError.
 */
export function packageScriptsAt(repo: ChurnRepo, rev: string): Record<string, string> | null {
  if (runGit(['ls-tree', '--name-only', rev, '--', 'package.json'], repo).trim() === '') return {};
  const raw = runGit(['show', `${rev}:package.json`], repo);
  try {
    const parsed: JsonValue = JSON.parse(raw);
    const scripts = isJsonObject(parsed) ? parsed.scripts : undefined;
    if (!isJsonObject(scripts)) return {};
    const out: Record<string, string> = {};
    for (const [name, command] of Object.entries(scripts)) {
      if (!isJsonString(command)) return {};
      out[name] = command;
    }
    return out;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}
