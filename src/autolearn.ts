/**
 * Auto-learn from errors and git history.
 * Agents learn from failures without explicit hippo remember calls.
 */

import { execSync, spawn } from 'child_process';
import { MemoryEntry, createMemory, Layer } from './memory.js';
import { loadAllEntries } from './store.js';
import { textOverlap } from './search.js';

/**
 * Create a MemoryEntry capturing a command failure.
 * Content format: "Command '<cmd>' failed: <truncated stderr>"
 */
export function captureError(
  exitCode: number,
  stderr: string,
  command: string
): MemoryEntry {
  // Truncate to first 500 chars to avoid storing megabytes of build logs
  const truncated = stderr.slice(0, 500).trim();
  const content = `Command '${command}' failed (exit ${exitCode}): ${truncated}`;

  // Derive a sanitized tag from the command name (first word, strip path)
  const cmdBase = command.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9-]/g, '');
  const tags = ['error'];
  if (cmdBase) tags.push(cmdBase.toLowerCase().slice(0, 30));

  return createMemory(content, {
    layer: Layer.Episodic,
    tags,
    source: 'autolearn',
  });
}

/**
 * Parse git log output for actionable lessons.
 * Looks for fix:, revert:, bug:, error:, hotfix: commit messages.
 */
export function extractLessons(gitLog: string): string[] {
  const lessons: string[] = [];
  const lines = gitLog.split('\n');

  // Patterns that indicate a lesson to learn from
  const patterns = [
    /^(fix|revert|bug|error|hotfix)(\(.+?\))?:\s*(.+)/i,
    /\b(fixed|reverted|corrected|resolved)\b.{3,100}/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('commit ') || trimmed.startsWith('Author:') || trimmed.startsWith('Date:')) {
      continue;
    }

    for (const pat of patterns) {
      const m = trimmed.match(pat);
      if (m) {
        // For conventional commits: use the full subject line (group 3 or full match)
        const lesson = (m[3] ?? m[0]).trim();
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

/**
 * Check if a substantially similar memory already exists.
 * Returns true if overlap > threshold (default 0.7).
 */
export function deduplicateLesson(
  hippoRoot: string,
  lesson: string,
  threshold = 0.7
): boolean {
  const entries = loadAllEntries(hippoRoot);

  for (const entry of entries) {
    const overlap = textOverlap(lesson, entry.content);
    if (overlap > threshold) return true;
  }

  return false;
}

/**
 * Run a command, streaming stdout/stderr to the terminal in real time.
 * Returns: { exitCode, stderr }.
 */
export function runWatched(command: string): Promise<{ exitCode: number; stderr: string }> {
  return new Promise((resolve) => {
    // Use shell: true so the command string is handled by the shell as-is
    const child = spawn(command, { shell: true, stdio: ['inherit', 'inherit', 'pipe'] });

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

/**
 * Fetch recent git log lines (subject lines only).
 * days: how many days of history to include.
 */
export function fetchGitLog(cwd: string, days: number): string {
  try {
    const since = `--since="${days} days ago"`;
    const raw = execSync(
      `git log ${since} --pretty=format:"%s" 2>&1`,
      { encoding: 'utf8', cwd, timeout: 10000 }
    );
    return raw;
  } catch {
    return '';
  }
}
