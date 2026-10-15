/** Auto-learn from errors and git history.
 *  Agents learn from failures without explicit hippo remember calls. */

import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'child_process';
import { spawnArgv } from '../util/spawn-argv.js';
import { MemoryEntry, createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../core/memory.js';
import type { Learning } from '../store/port/learning.js';
import { localFilesAt } from './roots.js';
import { textOverlap, tokenize } from '../util/tokenize.js';
import { assessAutomaticMemory } from '../core/memory-quality.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { errorMessage, log, errorFields } from '../util/log.js';

const AUTOLEARN_TEXT_CHARS = 500;
const AUTOLEARN_TAG_CHARS = 30;
const MAX_LESSON_CHARS = 500;

/** A memory of a failed command, "Command '<cmd>' failed: <truncated stderr>"; `hippo watch` stores its text and
 * tags through remember. */
export function captureError(
  exitCode: number,
  stderr: string,
  command: string,
  tenantId?: string,
): MemoryEntry {
  // Truncate to first 500 chars to avoid storing megabytes of build logs
  const clean = redactSecretsStrict(stderr);
  const wasTruncated = clean.length > AUTOLEARN_TEXT_CHARS;
  const truncated = clean.slice(0, AUTOLEARN_TEXT_CHARS).trim();
  const suffix = wasTruncated ? ' [truncated]' : '';
  // Strip leading env var assignments (KEY=val or key=val) before the actual command name
  const safeCmd = redactSecretsStrict(command.replace(/^([A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '').trim()) || '(redacted)';
  const content = `Command '${safeCmd}' failed (exit ${exitCode}): ${truncated}${suffix}`;

  // Derive a sanitized tag from the command name (first word, strip path)
  const cmdBase = safeCmd.split(/\s+/)[0].replace(/[^a-zA-Z0-9-]/g, '');
  const tags = ['error', 'autolearn'];
  if (cmdBase) tags.push(cmdBase.toLowerCase().slice(0, AUTOLEARN_TAG_CHARS));

  return createMemory(content, {
    layer: Layer.Episodic,
    tags,
    source: 'autolearn',
    confidence: 'observed',
    tenantId,
    baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  });
}

/** Parse git log output for actionable lessons.
 *  Looks for fix:, revert:, bug:, error:, hotfix: commit messages. */
export function extractLessons(gitLog: string, customPatterns?: string[]): string[] {
  const lessons: string[] = [];
  const lines = gitLog.split('\n');

  // Patterns that indicate a lesson to learn from
  // Covers: fix, revert, bug, error, hotfix, refactor, perf, chore, breaking, deprecate
  const prefixes =
    customPatterns?.join('|') ?? 'fix|revert|bug|error|hotfix|bugfix|refactor|perf|chore|breaking|deprecate';
  const patterns = [
    new RegExp(`^[a-f0-9]+\\s+(${prefixes})(\\(.+?\\))?:?\\s+(.+)`, 'i'),
    new RegExp(`^(${prefixes})(\\(.+?\\))?:?\\s+(.+)`, 'i'),
    /^(Fix|Revert|Bug|Hotfix|Bugfix|Refactor|Perf)\s+(.+)/,
    /\b(fixed|reverted|corrected|resolved|refactored|optimized|deprecated)\b.{3,100}/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('commit ') || trimmed.startsWith('Author:') || trimmed.startsWith('Date:')) {
      continue;
    }

    // Strip leading git hash if present (real hashes are hex, but be lenient with alphanumeric prefixes)
    const subject = trimmed.replace(/^[a-z0-9]{6,40}\s+/i, '');

    for (const pat of patterns) {
      const m = subject.match(pat);
      if (m) {
        // For conventional commits: use group 3 (message after prefix), group 2, or full match
        const lesson = (m[3] ?? m[2] ?? m[0]).trim();
        if (lesson.length > 5 && lesson.length < MAX_LESSON_CHARS) {
          lessons.push(lesson);
        }
        break;
      }
    }
  }

  // Deduplicate exact matches at extraction time
  return [...new Set(lessons)];
}

/** Split parsed lessons into ones worth storing and low-information ones; kept out of `extractLessons` so that
 * published parser's output cannot change.
 *  Order is preserved in both arrays, and both hold lessons with secret shapes redacted. */
export function partitionLessons(lessons: string[]) {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const lesson of lessons.map((l) => redactSecretsStrict(l))) {
    if (assessAutomaticMemory(lesson).accepted) {
      kept.push(lesson);
    } else {
      dropped.push(lesson);
    }
  }
  return { kept, dropped };
}

// Never matches a real tag; the exact textOverlap re-check drops any row the content filter let through.
const NO_TAG = '~no-such-tag~';

/** Rows that can pass the overlap test: those sharing a token with the lesson. Falls back to every row when every row
 * can match (no tokens, or a threshold below zero). */
function candidateEntries(learning: Learning, lesson: string, threshold: number, tenantId?: string): MemoryEntry[] {
  const tokens = tokenize(lesson);
  if (tokens.length === 0 || threshold < 0) {
    return learning.allEntries(tenantId);
  }
  return learning.entriesMentioning(tokens, NO_TAG, tenantId);
}

/** Check if a substantially similar memory already exists: true if overlap > threshold (default 0.7).
 * `tenantId` applies only on the root-string overload; a pre-loaded MemoryEntry[] is already scoped, so it is
 * ignored there. */
export function deduplicateLesson(
  hippoRootOrEntries: string | MemoryEntry[],
  lesson: string,
  threshold = 0.7,
  tenantId?: string,
): boolean {
  if (Array.isArray(hippoRootOrEntries)) return overlapsAny(hippoRootOrEntries, lesson, threshold);
  return isDuplicateLesson(localFilesAt(hippoRootOrEntries).learning, lesson, threshold, tenantId);
}

/** deduplicateLesson against the memories `learning` holds. */
function isDuplicateLesson(learning: Learning, lesson: string, threshold = 0.7, tenantId?: string): boolean {
  return overlapsAny(candidateEntries(learning, lesson, threshold, tenantId), lesson, threshold);
}

function overlapsAny(entries: readonly MemoryEntry[], lesson: string, threshold: number): boolean {
  return entries.some((entry) => textOverlap(lesson, entry.content) > threshold);
}

/** The most stderr `runWatched` returns; the terminal still gets all of it. */
const STDERR_TAIL_BYTES = 64 * 1024;

/** A transfer command that has not exited in this long is hung on a prompt or a dead remote. */
export const RUN_WATCHED_DEADLINE_MS = 30 * 60_000;

/** The command passed its deadline and was killed. */
export class RunWatchedTimeoutError extends Error {
  constructor(readonly deadlineMs: number, readonly stderr: string) {
    super(`the command did not exit within ${deadlineMs} ms and was killed`);
    this.name = 'RunWatchedTimeoutError';
  }
}

export interface RunWatchedOptions {
  /** Join argv with spaces and run it as one shell command line; kept for 2.x callers, new code uses runWatchedLine. */
  shell?: boolean;
}

/** Run argv[0] with the rest as its arguments and no shell, so `;`, `&` and `$()` reach it literally; stderr streams
 * live.
 * Returns: { exitCode, stderr } with only the last 64 KiB of stderr; rejects with RunWatchedTimeoutError past
 * `deadlineMs`. */
export function runWatched(
  argv: readonly string[],
  deadlineMs: number = RUN_WATCHED_DEADLINE_MS,
  opts: RunWatchedOptions = {},
): Promise<{ exitCode: number; stderr: string }> {
  if (opts.shell) return runWatchedLine(argv.join(' '), deadlineMs);
  return watchChild(spawnArgv(argv, WATCHED_SPAWN_OPTIONS), deadlineMs);
}

/** Run `line` as one shell command line, for text the caller wrote itself (`hippo watch --shell`); same result and
 * deadline as runWatched. */
export function runWatchedLine(
  line: string,
  deadlineMs: number = RUN_WATCHED_DEADLINE_MS,
): Promise<{ exitCode: number; stderr: string }> {
  return watchChild(spawn(line, { ...WATCHED_SPAWN_OPTIONS, windowsHide: true, shell: true }), deadlineMs);
}

const WATCHED_SPAWN_OPTIONS: SpawnOptions = { stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true };

function watchChild(child: ChildProcess, deadlineMs: number): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    let tail = Buffer.alloc(0);

    child.stderr?.on('data', (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
      process.stderr.write(chunk);
    });

    // SHORTCUT: kills the direct child only (the shell or cmd.exe when there is one); on Windows a grandchild can
    // outlive it.
    // A process-tree kill is the upgrade path.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new RunWatchedTimeoutError(deadlineMs, tail.toString('utf8')));
    }, deadlineMs);

    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stderr: tail.toString('utf8') });
    });

    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}

/** Check whether a directory is a git work tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    const raw = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      cwd,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return raw.trim() === 'true';
  } catch (err) {
    // Asking git about a folder that is no repo is the probe itself, so a failure is the expected answer.
    log.debug(`autolearn: not a git repo: ${errorMessage(err)}`, errorFields(err));
    return false;
  }
}

/** Fetch recent git log lines (subject lines only).
 *  days: how many days of history to include. */
export function fetchGitLog(cwd: string, days: number): string {
  try {
    const raw = execFileSync('git', [
      'log', `--since=${days} days ago`, '--pretty=format:%s',
    ], { encoding: 'utf8', cwd, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return raw;
  } catch (err) {
    log.warn(`autolearn: git log unavailable: ${errorMessage(err)}`, errorFields(err));
    return '';
  }
}
