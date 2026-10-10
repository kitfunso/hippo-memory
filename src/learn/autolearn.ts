/** Auto-learn from errors and git history.
 *  Agents learn from failures without explicit hippo remember calls. */

import { execSync, execFileSync, spawn } from 'child_process';
import { MemoryEntry, createMemory, Layer, DEFAULT_HALF_LIFE_DAYS } from '../core/memory.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { textOverlap } from '../util/tokenize.js';
import { assessAutomaticMemory } from '../core/memory-quality.js';
import { redactSecretsStrict } from '../util/secret-detect.js';
import { errorMessage, log } from '../util/log.js';

const AUTOLEARN_TEXT_CHARS = 500;
const AUTOLEARN_TAG_CHARS = 30;

/** A memory of a failed command, "Command '<cmd>' failed: <truncated stderr>"; `hippo watch` stores its text and tags through remember. */
export function captureError(
  exitCode: number,
  stderr: string,
  command: string,
  tenantId?: string,
): MemoryEntry {
  // Truncate to first 500 chars to avoid storing megabytes of build logs
  const clean = redactSecretsStrict(stderr);
  const wasTruncated = clean.length > 500;
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
  const prefixes = customPatterns?.join('|') ?? 'fix|revert|bug|error|hotfix|bugfix|refactor|perf|chore|breaking|deprecate';
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
        if (lesson.length > 5 && lesson.length < 500) {
          lessons.push(lesson);
        }
        break;
      }
    }
  }

  // Deduplicate exact matches at extraction time
  return [...new Set(lessons)];
}

/** Split parsed lessons into ones worth storing and low-information ones; kept out of `extractLessons` so that published parser's output cannot change.
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

/** Check if a substantially similar memory already exists: true if overlap > threshold (default 0.7).
 *  `tenantId` applies only on the root-string overload; a pre-loaded MemoryEntry[] is already scoped, so it is ignored there. */
export function deduplicateLesson(
  hippoRootOrEntries: string | MemoryEntry[],
  lesson: string,
  threshold = 0.7,
  tenantId?: string,
): boolean {
  const entries = Array.isArray(hippoRootOrEntries)
    ? hippoRootOrEntries
    : loadAllEntries(hippoRootOrEntries, tenantId);

  for (const entry of entries) {
    const overlap = textOverlap(lesson, entry.content);
    if (overlap > threshold) return true;
  }

  return false;
}

/** Run a command in a shell, streaming stderr live; never pass text the caller did not write.
 *  Returns: { exitCode, stderr }. */
export function runWatched(command: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    // Use shell: true so the command string is handled by the shell as-is
    const child = spawn(command, { shell: true, stdio: ['inherit', 'inherit', 'pipe'], windowsHide: true });

    const stderrChunks: Buffer[] = [];

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      // Also pass through to terminal
      process.stderr.write(chunk);
    });

    child.on('close', (code: number | null) => {
      resolve({
        exitCode: code ?? 1,
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });

    child.on('error', (err: Error) => {
      resolve({ exitCode: 1, stderr: err.message });
    });
  });
}

/** Check whether a directory is a git work tree. */
export function isGitRepo(cwd: string): boolean {
  try {
    const raw = execSync('git rev-parse --is-inside-work-tree', {
      encoding: 'utf8',
      cwd,
      timeout: 10000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return raw.trim() === 'true';
  } catch (err) {
    log.debug(`autolearn: not a git repo: ${errorMessage(err)}`);
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
    log.debug(`autolearn: git log unavailable: ${errorMessage(err)}`);
    return '';
  }
}
