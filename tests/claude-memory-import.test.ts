import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { learnFromMemoryMd } from '../src/cli.js';
import { initStore, loadAllEntries } from '../src/store.js';

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-claude-memory-'));
  made.push(dir);
  return dir;
};
// Claude Code's own rule for a project folder name.
const claudeFolder = (dir: string) => fs.realpathSync.native(dir).replace(/[^a-zA-Z0-9]/g, '-');

function writeLesson(home: string, project: string, file: string, body: string): void {
  const memDir = path.join(home, '.claude', 'projects', claudeFolder(project), 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, file), `---\nname: ${file}\ntype: feedback\n---\n${body}\n`, 'utf8');
}

function store(dir: string): string {
  const hippoRoot = path.join(dir, '.hippo');
  initStore(hippoRoot);
  return hippoRoot;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

const contents = (hippoRoot: string) => loadAllEntries(hippoRoot).map((e) => e.content).join('\n');

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('learnFromMemoryMd reads only the Claude Code memory of the store project', () => {
  it('imports its own project folder and no other project', () => {
    const home = tmp();
    const project = tmp();
    const other = tmp();
    writeLesson(home, project, 'own.md', 'Run the migration check before every deploy of this service.');
    writeLesson(home, other, 'other.md', 'The billing export for the other client runs on Fridays.');
    const hippoRoot = store(project);

    expect(learnFromMemoryMd(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('migration check before every deploy');
    expect(contents(hippoRoot)).not.toContain('billing export');
  });

  it('reads the repository folder for a store in a subfolder', () => {
    const home = tmp();
    const repo = tmp();
    git(repo, 'init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    writeLesson(home, repo, 'repo.md', 'The package tests need the fixture server started first.');

    expect(learnFromMemoryMd(store(path.join(repo, 'pkg')), home)).toBe(1);
  });

  it('reads the main checkout folder for a store in a linked worktree', () => {
    const home = tmp();
    const repo = tmp();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = path.join(tmp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    writeLesson(home, repo, 'main.md', 'Worktrees share the build cache, so clean it before a release build.');

    expect(learnFromMemoryMd(store(worktree), home)).toBe(1);
  });
});
