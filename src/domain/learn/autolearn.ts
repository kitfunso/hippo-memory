/** Auto-learn from errors and git history.
 *  Agents learn from failures without explicit hippo remember calls. */

import { MemoryEntry, createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../../base/memory/memory.js';
import { assessAutomaticMemory } from '../../base/memory/memory-quality.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';
import { errorMessage, log, errorFields } from '../../base/util/log.js';
import type { GitRunner } from '../../base/ports/git.js';
import { GIT_CALL_TIMEOUT_MS } from '../../base/util/time.js';

const AUTOLEARN_TEXT_CHARS = 500;
const AUTOLEARN_TAG_CHARS = 30;
const MAX_LESSON_CHARS = 500;

/** A memory of a failed command, "Command '<cmd>' failed: <truncated stderr>"; `hippo watch` stores its text and tags
 * through remember. */
export function captureError(exitCode: number, stderr: string, command: string, tenantId?: string): MemoryEntry {
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

  return [...new Set(lessons)];
}

/** Split parsed lessons into ones worth storing and low-information ones; kept out of `extractLessons` so that
 * published parser's output cannot change.
 * Order is preserved in both arrays, and both hold lessons with secret shapes redacted. */
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

/** Check whether a directory is a git work tree. */
export function isGitRepo(git: GitRunner, cwd: string): boolean {
  const probe = git.run(['rev-parse', '--is-inside-work-tree'], {
    cwd,
    timeoutMs: GIT_CALL_TIMEOUT_MS,
    stderr: 'drop',
  });
  if (probe.ok) return probe.stdout.trim() === 'true';
  // Asking git about a folder that is no repo is the probe itself, so a failure is the expected answer.
  log.debug(`autolearn: not a git repo: ${errorMessage(probe.error)}`, errorFields(probe.error));
  return false;
}

/** Fetch recent git log lines (subject lines only).
 *  days: how many days of history to include. */
export function fetchGitLog(git: GitRunner, cwd: string, days: number): string {
  const args = ['log', `--since=${days} days ago`, '--pretty=format:%s'];
  const read = git.run(args, { cwd, timeoutMs: GIT_CALL_TIMEOUT_MS, stderr: 'keep' });
  if (read.ok) return read.stdout;
  log.warn(`autolearn: git log unavailable: ${errorMessage(read.error)}`, errorFields(read.error));
  return '';
}
