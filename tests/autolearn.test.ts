import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, execFileSync } from 'child_process';
import { captureError, extractLessons, partitionLessons, deduplicateLesson, fetchGitLog, isGitRepo } from '../src/autolearn.js';
import { initStore, writeEntry, readEntry, loadAllEntries } from '../src/store.js';
import { createMemory } from '../src/memory.js';
import { extractInvalidationTarget, invalidateMatching } from '../src/invalidation.js';
import { handleMcpRequest, type McpResponse } from '../src/mcp/server.js';

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

  it('ignores non-matching commits', () => {
    const log = [
      'abc1234 feat: add dark mode',
      'ghi9012 docs: readme update',
      'jkl3456 ci: update pipeline',
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

    expect(lessonsB.length).toBe(3);
    expect(lessonsB.some((l) => l.includes('connection pool'))).toBe(true);
    expect(lessonsB.some((l) => l.includes('bad migration'))).toBe(true);
    expect(lessonsB.some((l) => l.includes('bump dependencies'))).toBe(true);

    // Combined set has no overlap
    const all = [...lessonsA, ...lessonsB];
    expect(new Set(all).size).toBe(all.length);
  });
});

// ---------------------------------------------------------------------------
// partitionLessons (DF4)
// ---------------------------------------------------------------------------

describe('partitionLessons', () => {
  // These are the six roadmap-named junk subjects: no path, number, flag or
  // other specific detail, so isContentWorthStoring rejects them.
  const junkSubjects = [
    'fixed signals',
    'globe view on by default',
    'corrected entry prices',
    'update readme',
    'wip',
    'refactor stuff',
  ];

  // These carry a path, number, or flag - specific enough to be worth
  // storing as a memory.
  const detailedSubjects = [
    'fix CI flake in session-end-snapshot-close.test.ts',
    'bump pool timeout to 30s in src/db.ts',
    'add --include-recent flag to hippo context',
  ];

  it('drops all six roadmap-named junk subjects', () => {
    const { kept, dropped } = partitionLessons(junkSubjects);
    expect(dropped).toEqual(junkSubjects);
    expect(kept).toEqual([]);
  });

  it('keeps all three detail-carrying subjects', () => {
    const { kept, dropped } = partitionLessons(detailedSubjects);
    expect(kept).toEqual(detailedSubjects);
    expect(dropped).toEqual([]);
  });

  it('preserves input order across a mixed batch', () => {
    const mixed = [junkSubjects[0], detailedSubjects[0], junkSubjects[1], detailedSubjects[1]];
    const { kept, dropped } = partitionLessons(mixed);
    expect(kept).toEqual([detailedSubjects[0], detailedSubjects[1]]);
    expect(dropped).toEqual([junkSubjects[0], junkSubjects[1]]);
  });

  it('returns empty arrays for an empty input', () => {
    expect(partitionLessons([])).toEqual({ kept: [], dropped: [] });
  });

  // Anti-coupling pin (the grill's objection from the DF4 plan): autolearn is
  // now the FOURTH consumer of isContentWorthStoring, after the capture
  // write gate, the DF3 include-recent floor, and auditMemory. A prior
  // release widened that shared predicate and silently changed behaviour
  // for a consumer nobody re-swept (v1.36.0 ship-gate incident). This test
  // pins autolearn's OWN admission boundary against fixed inputs, so if a
  // future change to isContentWorthStoring moves that boundary, it fails
  // HERE - loud and attributable to autolearn - instead of quietly
  // changing what git auto-learn ingests with no test noticing.
  it('pins the admission boundary against the shared predicate (anti-coupling)', () => {
    const { kept, dropped } = partitionLessons([...junkSubjects, ...detailedSubjects]);
    expect(dropped.sort()).toEqual([...junkSubjects].sort());
    expect(kept.sort()).toEqual([...detailedSubjects].sort());
  });
});

// ---------------------------------------------------------------------------
// extractLessons stays a pure parser (DF4: filtering moved to the write
// path, not into the parser - a junk subject the parser recognizes as a
// "fix"-shaped commit is still RETURNED here; partitionLessons is what
// drops it before storage).
// ---------------------------------------------------------------------------

describe('extractLessons unchanged by DF4', () => {
  it('still returns a low-information subject the parser recognizes', () => {
    // "fixed signals" matches the loose \b(fixed|...)\b pattern - the parser
    // has no quality predicate and never should; admission happens later.
    const lessons = extractLessons('abc1234 fixed signals');
    expect(lessons).toContain('fixed signals');
  });

  it('still returns "corrected entry prices" from a matching commit line', () => {
    const lessons = extractLessons('def5678 corrected entry prices');
    expect(lessons).toContain('corrected entry prices');
  });
});

// ---------------------------------------------------------------------------
// Write-path wiring (DF4): both `hippo learn --git` (CLI) and the MCP
// `hippo_learn` tool must run parsed lessons through partitionLessons
// before they reach the store. A junk subject must not survive; a
// detail-carrying one must.
// ---------------------------------------------------------------------------

const CLI = path.join(process.cwd(), 'dist', 'src', 'cli.js');

function initGitRepoWithCommits(subjects: string[]): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df4-repo-'));
  execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
  execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
  subjects.forEach((subject, i) => {
    fs.writeFileSync(path.join(repoDir, `f${i}.txt`), String(i));
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', subject], { cwd: repoDir, stdio: 'ignore' });
  });
  return repoDir;
}

describe('DF4 write-path gate: CLI `hippo learn --git`', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    repoDir = initGitRepoWithCommits([
      'fixed signals',
      'corrected entry prices',
      'fix CI flake in session-end-snapshot-close.test.ts',
      'hotfix: pool timeout bumped to 30s in src/db.ts',
    ]);
    globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df4-global-'));
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    execFileSync('node', [CLI, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
      cwd: repoDir,
      env,
    });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });

  it('drops junk subjects and stores detail-carrying ones, reporting the count', () => {
    const output = execFileSync('node', [CLI, 'learn', '--git', '--days', '3650'], {
      cwd: repoDir,
      env,
      encoding: 'utf8',
    });

    expect(output).toMatch(/low-information subject\(s\) dropped/);

    const entries = loadAllEntries(path.join(repoDir, '.hippo'));
    const contents = entries.map((e) => e.content);
    expect(contents.some((c) => c.includes('fixed signals'))).toBe(false);
    expect(contents.some((c) => c.includes('corrected entry prices'))).toBe(false);
    expect(contents.some((c) => c.includes('session-end-snapshot-close.test.ts'))).toBe(true);
    expect(contents.some((c) => c.includes('src/db.ts'))).toBe(true);
  });
});

describe('DF4: a gated lesson still invalidates', () => {
  let repoDir: string;
  let globalRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    // "replace webpack with vite" is a MIGRATION subject that FAILS the
    // quality heuristic. Both facts matter: it must still supersede stale
    // webpack memories even though it is not itself worth storing.
    repoDir = initGitRepoWithCommits(['refactor: replace webpack with vite']);
    globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df4-inv-'));
    env = { ...process.env, HIPPO_HOME: globalRoot, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' };
    execFileSync('node', [CLI, 'init', '--no-hooks', '--no-schedule', '--no-learn'], {
      cwd: repoDir,
      env,
    });
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(globalRoot, { recursive: true, force: true });
  });

  it('weakens stale memories even when the subject is too thin to store', () => {
    // The admission gate is about STORAGE. An earlier revision filtered the
    // loop input instead of the write, which removed dropped lessons from
    // the invalidation pass too - so this migration silently stopped
    // superseding anything. Codex P1 on this branch; this pins the fix.
    const repoRoot = path.join(repoDir, '.hippo');
    const stale = createMemory('webpack config uses HtmlWebpackPlugin for output', {
      tags: ['webpack', 'build'],
    });
    writeEntry(repoRoot, stale);

    execFileSync('node', [CLI, 'learn', '--git', '--days', '3650'], {
      cwd: repoDir,
      env,
      encoding: 'utf8',
    });

    const updated = readEntry(repoRoot, stale.id);
    expect(updated, 'the stale memory should still exist').not.toBeNull();
    expect(updated!.tags, 'invalidation must run for a gated lesson').toContain('invalidated');

    // ...and the thin subject itself is still not stored.
    const contents = loadAllEntries(repoRoot).map((e) => e.content);
    expect(contents.some((c) => c.includes('replace webpack with vite'))).toBe(false);
  });
});

describe('DF4 write-path gate: MCP hippo_learn tool', () => {
  let repoDir: string;
  let hippoRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    repoDir = initGitRepoWithCommits([
      'fixed signals',
      'fix --include-recent flag handling in hippo context',
    ]);
    hippoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-df4-mcp-'));
    initStore(hippoRoot);
    originalCwd = process.cwd();
    process.chdir(repoDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(hippoRoot, { recursive: true, force: true });
  });

  it('drops junk subjects and stores detail-carrying ones via the MCP tool', async () => {
    const res = (await handleMcpRequest(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'hippo_learn', arguments: { days: 3650 } },
      },
      { hippoRoot, tenantId: 'default', actor: 'mcp' },
    )) as McpResponse | null;

    const text = (res as { result?: { content?: Array<{ text?: string }> } } | null)
      ?.result?.content?.[0]?.text ?? '';
    expect(text).toMatch(/low-information subjects dropped/);

    const entries = loadAllEntries(hippoRoot);
    const contents = entries.map((e) => e.content);
    expect(contents.some((c) => c.includes('fixed signals'))).toBe(false);
    expect(contents.some((c) => c.includes('--include-recent'))).toBe(true);
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

describe('git repo detection', () => {
  it('treats an empty recent history window as a real git repo, not a missing repo', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-gitlog-'));

    try {
      execSync('git init', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.name "Test User"', { cwd: repoDir, stdio: 'ignore' });
      execSync('git config user.email "test@example.com"', { cwd: repoDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
      execSync('git add README.md', { cwd: repoDir, stdio: 'ignore' });
      execSync('git commit -m "docs: old commit"', {
        cwd: repoDir,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
        },
      });

      expect(isGitRepo(repoDir)).toBe(true);
      expect(fetchGitLog(repoDir, 1)).toBe('');
    } finally {
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it('returns false for a non-git directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-not-git-'));

    try {
      expect(isGitRepo(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

// ---------------------------------------------------------------------------
// Invalidation during git learning
// ---------------------------------------------------------------------------

describe('invalidation during git learning', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-inv-learn-'));
    initStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('invalidates old memories when learning a migration commit', () => {
    // Setup: create an existing memory about webpack
    const mem = createMemory('webpack config uses HtmlWebpackPlugin for output', {
      tags: ['webpack', 'build'],
    });
    writeEntry(tmpDir, mem);

    // Extract invalidation target from a migration commit message
    const target = extractInvalidationTarget('feat: migrate from webpack to vite');
    expect(target).not.toBeNull();
    expect(target!.from).toBe('webpack');
    expect(target!.to).toBe('vite');

    // Invalidate matching memories
    const result = invalidateMatching(tmpDir, target!);
    expect(result.invalidated).toBe(1);

    // Verify the old memory was weakened
    const updated = readEntry(tmpDir, mem.id);
    expect(updated).not.toBeNull();
    expect(updated!.tags).toContain('invalidated');
    expect(updated!.confidence).toBe('stale');
    expect(updated!.half_life_days).toBeLessThan(mem.half_life_days);
  });

  it('does not invalidate memories for non-migration commits', () => {
    const mem = createMemory('webpack config uses HtmlWebpackPlugin for output', {
      tags: ['webpack', 'build'],
    });
    writeEntry(tmpDir, mem);

    const target = extractInvalidationTarget('fix: correct off-by-one in pagination');
    expect(target).toBeNull();

    // Memory should remain unchanged
    const updated = readEntry(tmpDir, mem.id);
    expect(updated!.tags).not.toContain('invalidated');
    expect(updated!.half_life_days).toBe(mem.half_life_days);
  });
});
