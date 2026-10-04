import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { importProjectMemories } from '../src/agent-memories/sync.js';
import { totalTally } from '../src/agent-memories/report.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';

const learnFromClaude = (hippoRoot: string, home: string): number =>
  totalTally(importProjectMemories(hippoRoot, { machine: { home, env: {}, platform: process.platform } })).imported;

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-claude-memory-'));
  made.push(dir);
  return dir;
};
// Claude Code's own rule for a project folder name, hash included.
function claudeName(full: string): string {
  const name = full.replace(/[^a-zA-Z0-9]/g, '-');
  let hash = 0;
  for (let i = 0; i < full.length; i++) hash = ((hash << 5) - hash + full.charCodeAt(i)) | 0;
  return name.length <= 200 ? name : `${name.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
const claudeFolder = (dir: string) => claudeName(fs.realpathSync.native(dir));

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

describe('the project pass reads only the Claude Code memory of the store project', () => {
  it('imports its own project folder and no other project', () => {
    const home = tmp();
    const project = tmp();
    const other = tmp();
    writeLesson(home, project, 'own.md', 'Run the migration check before every deploy of this service.');
    writeLesson(home, other, 'other.md', 'The billing export for the other client runs on Fridays.');
    const hippoRoot = store(project);

    expect(learnFromClaude(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('migration check before every deploy');
    expect(contents(hippoRoot)).not.toContain('billing export');
  });

  it('reads the repository folder for a store in a subfolder', () => {
    const home = tmp();
    const repo = tmp();
    git(repo, 'init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    writeLesson(home, repo, 'repo.md', 'The package tests need the fixture server started first.');

    expect(learnFromClaude(store(path.join(repo, 'pkg')), home)).toBe(1);
  });

  it('reads the main checkout folder for a store in a linked worktree', () => {
    const home = tmp();
    const repo = tmp();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = path.join(tmp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    writeLesson(home, repo, 'main.md', 'Worktrees share the build cache, so clean it before a release build.');

    expect(learnFromClaude(store(worktree), home)).toBe(1);
  });

  it("reads a bare repository's folder, not its parent's, for a store in its worktree", () => {
    const home = tmp();
    const parent = tmp();
    const seed = tmp();
    git(seed, 'init', '-q');
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(parent, 'clone', '-q', '--bare', seed, 'proj.git');
    git(path.join(parent, 'proj.git'), 'worktree', 'add', '-q', path.join(parent, 'wt'));
    writeLesson(home, path.join(parent, 'proj.git'), 'bare.md', 'This repository needs the fixture server before its tests run.');
    writeLesson(home, parent, 'parent.md', 'The parent folder keeps its invoices under the finance share.');
    const hippoRoot = store(path.join(parent, 'wt'));

    expect(learnFromClaude(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('fixture server');
  });

  it('reads the checkout folder of a repository whose git folder lives elsewhere', () => {
    const home = tmp();
    const base = tmp();
    fs.mkdirSync(path.join(base, 'gitdirs'));
    git(base, 'init', '-q', `--separate-git-dir=${path.join(base, 'gitdirs', 'proj.git')}`, 'proj');
    writeLesson(home, path.join(base, 'proj'), 'own.md', 'Run the schema check before this project ships.');
    writeLesson(home, path.join(base, 'gitdirs'), 'gitdirs.md', 'The gitdirs folder holds backups for a different client.');
    const hippoRoot = store(path.join(base, 'proj'));

    expect(learnFromClaude(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('schema check');
  });

  it('reads the submodule root folder for a store in a submodule subfolder', () => {
    const home = tmp();
    const lib = tmp();
    git(lib, 'init', '-q');
    git(lib, 'commit', '-q', '--allow-empty', '-m', 'init');
    const sup = tmp();
    git(sup, 'init', '-q');
    git(sup, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    fs.mkdirSync(path.join(sup, 'lib', 'pkg'));
    writeLesson(home, path.join(sup, 'lib'), 'lib.md', 'The submodule build needs the vendored headers.');
    writeLesson(home, sup, 'super.md', 'The superproject deploys from the release branch only.');
    const hippoRoot = store(path.join(sup, 'lib', 'pkg'));

    expect(learnFromClaude(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('vendored headers');
  });

  it("reads the folder Claude Code names with a hash when the project's name passes 200 characters", () => {
    // Vector from Claude Code's own function, so the oracle above cannot drift from it.
    expect(claudeName(`/tmp/${'p'.repeat(210)}`).slice(195)).toBe('ppppp-4wf9bb');
    const home = tmp();
    const base = tmp();
    const project = path.join(base, 'p'.repeat(Math.max(1, 205 - base.length)));
    fs.mkdirSync(project);
    writeLesson(home, project, 'own.md', 'The long-path project pins its toolchain in the lockfile.');

    expect(claudeFolder(project).length).toBeGreaterThan(200);
    expect(learnFromClaude(store(project), home)).toBe(1);
  });

  it("reads a long-named repository's hashed folder for a store in a subfolder", () => {
    // git prints a win32 toplevel as C:/..., while Claude Code hashes the resolved C:\... form.
    const home = tmp();
    const base = fs.realpathSync.native(tmp());
    const repo = path.join(base, 'r'.repeat(204 - base.length));
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    writeLesson(home, repo, 'repo.md', 'The long-named repository builds its docs before the package.');

    expect(claudeFolder(repo).length).toBeGreaterThan(200);
    expect(learnFromClaude(store(path.join(repo, 'pkg')), home)).toBe(1);
  });

  it('keeps a folder name of exactly 200 characters plain', () => {
    const home = tmp();
    const base = fs.realpathSync.native(tmp());
    const project = path.join(base, 'q'.repeat(199 - base.length));
    fs.mkdirSync(project);
    writeLesson(home, project, 'own.md', 'The exact-length project keeps its fixtures beside the tests.');

    expect(claudeFolder(project)).toHaveLength(200);
    expect(learnFromClaude(store(project), home)).toBe(1);
  });

  it("keeps a bare repository's worktree in its own folder when the bare repository holds a .git entry", () => {
    const home = tmp();
    const parent = tmp();
    const seed = tmp();
    git(seed, 'init', '-q');
    git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
    git(parent, 'clone', '-q', '--bare', seed, 'proj.git');
    git(path.join(parent, 'proj.git'), 'worktree', 'add', '-q', path.join(parent, 'wt'));
    fs.mkdirSync(path.join(parent, 'proj.git', '.git'));
    writeLesson(home, path.join(parent, 'wt'), 'own.md', 'This worktree runs the smoke tests against staging only.');
    writeLesson(home, path.join(parent, 'proj.git'), 'bare.md', 'The bare repository mirrors the upstream every night.');
    const hippoRoot = store(path.join(parent, 'wt'));

    expect(learnFromClaude(hippoRoot, home)).toBe(1);
    expect(contents(hippoRoot)).toContain('smoke tests');
    expect(contents(hippoRoot)).not.toContain('mirrors the upstream');
  });
});
