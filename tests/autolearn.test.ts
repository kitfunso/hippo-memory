import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { captureError, extractLessons, deduplicateLesson } from '../src/autolearn.js';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory } from '../src/memory.js';

// ---------------------------------------------------------------------------
// captureError
// ---------------------------------------------------------------------------

describe('captureError', () => {
  it('creates a memory entry with error tags', () => {
    const entry = captureError(1, 'TypeError: Cannot read property x', 'npm test');
    expect(entry.tags).toContain('error');
    expect(entry.tags).toContain('autolearn');
    expect(entry.content).toContain('npm test');
    expect(entry.content).toContain('TypeError');
  });

  it('truncates stderr to 500 chars', () => {
    const longStderr = 'x'.repeat(600);
    const entry = captureError(2, longStderr, 'cmd');
    expect(entry.content.length).toBeLessThan(700);
    expect(entry.content).toContain('truncated');
  });

  it('includes exit code in content', () => {
    const entry = captureError(127, 'command not found', 'badcmd');
    expect(entry.content).toContain('exit 127');
  });

  it('sets emotional_valence to negative', () => {
    const entry = captureError(1, 'err', 'cmd');
    expect(entry.emotional_valence).toBe('negative');
  });

  it('short stderr passes through unchanged', () => {
    const stderr = 'short error';
    const entry = captureError(1, stderr, 'cmd');
    expect(entry.content).toContain('short error');
    expect(entry.content).not.toContain('truncated');
  });
});

// ---------------------------------------------------------------------------
// extractLessons
// ---------------------------------------------------------------------------

describe('extractLessons', () => {
  it('extracts lessons from fix commits', () => {
    const log = [
      'abc1234 fix: null pointer in cache refresh',
      'def5678 feat: add new dashboard',
      'ghi9012 Fix broken pipeline logic',
    ].join('\n');

    const lessons = extractLessons(log);
    expect(lessons.length).toBe(2);
    expect(lessons.some((l) => l.includes('null pointer'))).toBe(true);
    expect(lessons.some((l) => l.includes('broken pipeline'))).toBe(true);
  });

  it('extracts lessons from revert commits', () => {
    const log = 'abc1234 revert bad deploy changes';
    const lessons = extractLessons(log);
    expect(lessons.length).toBe(1);
    expect(lessons[0]).toContain('bad deploy');
  });

  it('extracts lessons from bug/bugfix commits', () => {
    const log = [
      'abc1234 bugfix: race condition in scheduler',
      'def5678 bug in auth token refresh',
    ].join('\n');

    const lessons = extractLessons(log);
    expect(lessons.length).toBe(2);
  });

  it('ignores non-fix commits', () => {
    const log = [
      'abc1234 feat: add dark mode',
      'def5678 chore: update dependencies',
      'ghi9012 docs: readme update',
    ].join('\n');

    const lessons = extractLessons(log);
    expect(lessons.length).toBe(0);
  });

  it('returns empty array for empty log', () => {
    expect(extractLessons('')).toEqual([]);
  });

  it('extracts lessons from multi-repo combined output', () => {
    // Simulate concatenated git logs from multiple repos
    const repoALog = [
      'aaa1111 fix: broken auth flow in login page',
      'bbb2222 feat: add search bar',
    ].join('\n');

    const repoBLog = [
      'ccc3333 hotfix: database connection pool exhaustion',
      'ddd4444 chore: bump dependencies',
      'eee5555 revert: rolled back bad migration',
    ].join('\n');

    const lessonsA = extractLessons(repoALog);
    const lessonsB = extractLessons(repoBLog);

    expect(lessonsA.length).toBe(1);
    expect(lessonsA[0]).toContain('broken auth flow');

    expect(lessonsB.length).toBe(2);
    expect(lessonsB.some((l) => l.includes('connection pool'))).toBe(true);
    expect(lessonsB.some((l) => l.includes('bad migration'))).toBe(true);

    // Combined set has no overlap
    const all = [...lessonsA, ...lessonsB];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ---------------------------------------------------------------------------
// deduplicateLesson
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// HOOKS config (verified by reading source)
// ---------------------------------------------------------------------------

describe('HOOKS config', () => {
  const cliSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'cli.ts'), 'utf8');

  it('openclaw hook targets AGENTS.md', () => {
    // The openclaw entry in HOOKS should use AGENTS.md, not a skill file
    expect(cliSource).toContain("'openclaw': {");
    expect(cliSource).toContain("file: 'AGENTS.md',");
    // Ensure it does NOT point to the old skill path
    expect(cliSource).not.toContain('.openclaw/skills/hippo/SKILL.md');
  });

  it('openclaw hook content includes key commands', () => {
    expect(cliSource).toContain('hippo context --auto --budget 1500');
    expect(cliSource).toContain('hippo outcome --good');
    expect(cliSource).toContain('hippo learn --git');
  });
});

// ---------------------------------------------------------------------------
// deduplicateLesson
// ---------------------------------------------------------------------------

describe('deduplicateLesson', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-dedup-'));
    initStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when no similar memory exists', () => {
    const isDup = deduplicateLesson(tmpDir, 'lesson about cache refresh');
    expect(isDup).toBe(false);
  });

  it('returns true when an identical lesson exists', () => {
    const lesson = 'lesson about cache refresh pipeline error';
    const entry = createMemory(lesson);
    writeEntry(tmpDir, entry);

    const isDup = deduplicateLesson(tmpDir, lesson);
    expect(isDup).toBe(true);
  });

  it('returns true for near-duplicate lesson (>0.7 overlap)', () => {
    const existing = 'lesson about cache refresh pipeline error fix';
    const entry = createMemory(existing);
    writeEntry(tmpDir, entry);

    const similar = 'lesson about cache refresh pipeline error bug';
    const isDup = deduplicateLesson(tmpDir, similar);
    expect(isDup).toBe(true);
  });

  it('returns false for unrelated lesson', () => {
    const existing = 'lesson about cache refresh pipeline error';
    const entry = createMemory(existing);
    writeEntry(tmpDir, entry);

    const unrelated = 'completely different content about authentication tokens jwt';
    const isDup = deduplicateLesson(tmpDir, unrelated);
    expect(isDup).toBe(false);
  });
});
