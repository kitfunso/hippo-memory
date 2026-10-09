import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { claudeCodeAdapter, claudeFolderName, claudeMemoryFolderNames, claudeTranscriptListing, transcriptNotesProject } from '../src/agent-memories/claude-code.js';
import type { AdapterContext, Container } from '../src/agent-memories/types.js';
import type { JsonObject } from '../src/store/working-memory.js';

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
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
const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

const configOf = (home: string) => path.join(home, '.claude');
const memDirOf = (config: string, project: string) => path.join(config, 'projects', claudeFolder(project), 'memory');
const ctxOf = (home: string, over: Partial<AdapterContext> = {}): AdapterContext => ({
  home,
  env: {},
  platform: process.platform,
  ...over,
});
const note = (body: string, yaml = 'type: feedback') => `---\nname: n\n${yaml}\n---\n${body}\n`;

function writeIn(dir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
}
function writeLesson(home: string, project: string, file: string, body: string): void {
  writeIn(memDirOf(configOf(home), project), file, note(body));
}
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}
function seedRepo(): string {
  const seed = tmp();
  git(seed, 'init', '-q');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
  return seed;
}
function bareWithWorktree() {
  const parent = tmp();
  git(parent, 'clone', '-q', '--bare', seedRepo(), 'proj.git');
  const bare = path.join(parent, 'proj.git');
  const wt = path.join(parent, 'wt');
  git(bare, 'worktree', 'add', '-q', wt);
  return { parent, bare, wt };
}
const listed = (home: string, projectRoot: string) =>
  claudeCodeAdapter.list(ctxOf(home, { projectRoot }), 'project').containers.map((c) => norm(c.path)).sort();

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('claudeCodeAdapter project layouts', () => {
  it('lists its own project folder and no other project', () => {
    const home = tmp();
    const project = tmp();
    writeLesson(home, project, 'own.md', 'Run the migration check before every deploy of this service.');
    writeLesson(home, tmp(), 'other.md', 'The billing export for the other client runs on Fridays.');

    const listing = claudeCodeAdapter.list(ctxOf(home, { projectRoot: project }), 'project');
    expect(listing.tool).toBe('claude-code');
    expect(listing.containers.map((c) => norm(c.path))).toEqual([norm(memDirOf(configOf(home), project))]);
    expect(listing.containers[0].scope).toBe('project');
    expect(listing.containers[0].items.map((i) => i.key)).toEqual(['own.md']);
  });

  it('lists the repository folder for a project root in a subfolder', () => {
    const home = tmp();
    const repo = tmp();
    git(repo, 'init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    writeLesson(home, repo, 'repo.md', 'The package tests need the fixture server started first.');

    expect(listed(home, path.join(repo, 'pkg'))).toEqual([norm(memDirOf(configOf(home), repo))]);
  });

  it('lists the main checkout folder for a linked worktree', () => {
    const home = tmp();
    const repo = seedRepo();
    const worktree = path.join(tmp(), 'wt');
    git(repo, 'worktree', 'add', '-q', worktree);
    writeLesson(home, repo, 'main.md', 'Worktrees share the build cache, so clean it before a release build.');

    expect(listed(home, worktree)).toEqual([norm(memDirOf(configOf(home), repo))]);
  });

  it("lists a bare repository's folder, not its parent's, for its worktree", () => {
    const home = tmp();
    const { parent, bare, wt } = bareWithWorktree();
    writeLesson(home, bare, 'bare.md', 'This repository needs the fixture server before its tests run.');
    writeLesson(home, parent, 'parent.md', 'The parent folder keeps its invoices under the finance share.');

    expect(listed(home, wt)).toEqual([norm(memDirOf(configOf(home), bare))]);
  });

  it('lists the checkout folder of a repository whose git folder lives elsewhere', () => {
    const home = tmp();
    const base = tmp();
    fs.mkdirSync(path.join(base, 'gitdirs'));
    git(base, 'init', '-q', `--separate-git-dir=${path.join(base, 'gitdirs', 'proj.git')}`, 'proj');
    writeLesson(home, path.join(base, 'proj'), 'own.md', 'Run the schema check before this project ships.');
    writeLesson(home, path.join(base, 'gitdirs'), 'gitdirs.md', 'The gitdirs folder holds backups for a different client.');

    expect(listed(home, path.join(base, 'proj'))).toEqual([norm(memDirOf(configOf(home), path.join(base, 'proj')))]);
  });

  it('lists the submodule root folder for a submodule subfolder', () => {
    const home = tmp();
    const lib = seedRepo();
    const sup = seedRepo();
    git(sup, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    fs.mkdirSync(path.join(sup, 'lib', 'pkg'));
    writeLesson(home, path.join(sup, 'lib'), 'lib.md', 'The submodule build needs the vendored headers.');
    writeLesson(home, sup, 'super.md', 'The superproject deploys from the release branch only.');

    expect(listed(home, path.join(sup, 'lib', 'pkg'))).toEqual([norm(memDirOf(configOf(home), path.join(sup, 'lib')))]);
  });

  it("lists the folder Claude Code names with a hash when the project's name passes 200 characters", () => {
    // Vector from Claude Code's own function, so the oracle above cannot drift from it.
    expect(claudeName(`/tmp/${'p'.repeat(210)}`).slice(195)).toBe('ppppp-4wf9bb');
    const home = tmp();
    const base = tmp();
    const project = path.join(base, 'p'.repeat(Math.max(1, 205 - base.length)));
    fs.mkdirSync(project);
    writeLesson(home, project, 'own.md', 'The long-path project pins its toolchain in the lockfile.');

    expect(claudeFolder(project).length).toBeGreaterThan(200);
    expect(listed(home, project)).toEqual([norm(memDirOf(configOf(home), project))]);
  });

  it("lists a long-named repository's hashed folder for a subfolder", () => {
    // git prints a win32 toplevel as C:/..., while Claude Code hashes the resolved C:\... form.
    const home = tmp();
    const base = fs.realpathSync.native(tmp());
    const repo = path.join(base, 'r'.repeat(204 - base.length));
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    fs.mkdirSync(path.join(repo, 'pkg'));
    writeLesson(home, repo, 'repo.md', 'The long-named repository builds its docs before the package.');

    expect(claudeFolder(repo).length).toBeGreaterThan(200);
    expect(listed(home, path.join(repo, 'pkg'))).toEqual([norm(memDirOf(configOf(home), repo))]);
  });

  it('keeps a folder name of exactly 200 characters plain', () => {
    const home = tmp();
    const base = fs.realpathSync.native(tmp());
    const project = path.join(base, 'q'.repeat(199 - base.length));
    fs.mkdirSync(project);
    writeLesson(home, project, 'own.md', 'The exact-length project keeps its fixtures beside the tests.');

    expect(claudeFolder(project)).toHaveLength(200);
    expect(claudeFolderName(project)).toBe(claudeFolder(project));
    expect(listed(home, project)).toEqual([norm(memDirOf(configOf(home), project))]);
  });

  it("keeps a bare repository's worktree in its own folder when the bare repository holds a .git entry", () => {
    const home = tmp();
    const { bare, wt } = bareWithWorktree();
    fs.mkdirSync(path.join(bare, '.git'));
    writeLesson(home, wt, 'own.md', 'This worktree runs the smoke tests against staging only.');
    writeLesson(home, bare, 'bare.md', 'The bare repository mirrors the upstream every night.');

    expect(listed(home, wt)).toEqual([norm(memDirOf(configOf(home), wt))]);
  });

  it('lowercases folder names on win32 only', () => {
    const project = tmp();
    const plain = claudeFolder(project);
    expect(claudeMemoryFolderNames(project, 'win32')).toContain(plain.toLowerCase());
    expect(claudeMemoryFolderNames(project, 'linux')).toContain(plain);
  });
});

describe('claudeCodeAdapter config folder and project name rules', () => {
  it('uses <home>/.claude by default and CLAUDE_CONFIG_DIR when set', () => {
    const home = tmp();
    const project = tmp();
    const cfg = path.join(tmp(), 'cfg');
    writeLesson(home, project, 'default.md', 'The default folder holds this note for the project.');
    writeIn(memDirOf(cfg, project), 'pinned.md', note('The pinned config folder holds this note.'));

    const plain = claudeCodeAdapter.list(ctxOf(home, { projectRoot: project }), 'project');
    expect(plain.home).toBe(configOf(home));
    expect(plain.containers[0].items.map((i) => i.key)).toEqual(['default.md']);

    const pinned = claudeCodeAdapter.list(ctxOf(home, { projectRoot: project, env: { CLAUDE_CONFIG_DIR: cfg } }), 'project');
    expect(pinned.home).toBe(cfg);
    expect(pinned.containers.map((c) => norm(c.path))).toEqual([norm(memDirOf(cfg, project))]);
    expect(pinned.containers[0].items.map((i) => i.key)).toEqual(['pinned.md']);
  });

  it('adds the CLAUDE_CODE_PROJECT_DIR_NAME folder only alongside CLAUDE_CONFIG_DIR', () => {
    const home = tmp();
    const cfg = path.join(tmp(), 'cfg');
    const pinnedIn = (config: string) => path.join(config, 'projects', 'my_proj-1', 'memory');
    writeIn(pinnedIn(cfg), 'a.md', note('A note in the pinned project folder.'));
    writeIn(pinnedIn(configOf(home)), 'b.md', note('A note in the default config folder.'));
    const paths = (env: Record<string, string>) =>
      claudeCodeAdapter.list(ctxOf(home, { env }), 'project').containers.map((c) => norm(c.path));

    expect(paths({ CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_PROJECT_DIR_NAME: 'my_proj-1' })).toEqual([norm(pinnedIn(cfg))]);
    expect(paths({ CLAUDE_CODE_PROJECT_DIR_NAME: 'my_proj-1' })).toEqual([]);
    expect(paths({ CLAUDE_CONFIG_DIR: cfg })).toEqual([]);
  });

  it('accepts a 64-character pinned name and refuses separators, spaces and 65 characters', () => {
    const home = tmp();
    const cfg = path.join(tmp(), 'cfg');
    const found = (name: string) =>
      claudeCodeAdapter.list(ctxOf(home, { env: { CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_PROJECT_DIR_NAME: name } }), 'project').containers;
    for (const name of ['x'.repeat(64), '../out', 'a/b', 'a b', 'x'.repeat(65), '']) {
      writeIn(path.join(cfg, 'projects', name, 'memory'), 'n.md', note('A note that only a valid name may reach.'));
    }

    expect(found('x'.repeat(64))).toHaveLength(1);
    for (const name of ['../out', 'a/b', 'a b', 'x'.repeat(65), '']) expect(found(name)).toEqual([]);
  });

  it('lists the session folder memory alone', () => {
    const session = path.join(tmp(), 'projects', 'sess');
    writeIn(path.join(session, 'memory'), 'a.md', note('A note the session wrote for itself.'));
    const alone = claudeTranscriptListing(ctxOf(tmp()), path.join(session, 't.jsonl'));
    expect(alone.containers.map((c) => c.path)).toEqual([path.join(session, 'memory')]);
  });

  it('gives session folder notes the project of the folder Claude filed them for, cwd or a parent', () => {
    const launch = tmp();
    const repo = path.join(launch, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const transcriptOf = (dir: string) => path.join(tmp(), 'projects', claudeFolder(dir), 't.jsonl');

    expect(transcriptNotesProject(transcriptOf(launch), repo, { platform: process.platform, env: {} })?.name).toBe('');
    expect(transcriptNotesProject(transcriptOf(repo), path.join(repo, 'src'), { platform: process.platform, env: {} })?.name).toBe('repo');
    expect(transcriptNotesProject(transcriptOf(repo), tmp(), { platform: process.platform, env: {} })).toBeNull();
    expect(transcriptNotesProject(transcriptOf(repo), null, { platform: process.platform, env: {} })).toBeNull();
  });

  it('reads the start folder from the transcript, which the lossy folder name cannot give back, and decides nothing for a folder gone from disk', () => {
    const launch = tmp();
    const [dash, under] = [path.join(launch, 'my-repo'), path.join(launch, 'my_repo')];
    for (const repo of [dash, under]) fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const transcript = path.join(tmp(), 'projects', claudeFolder(under), 't.jsonl');
    writeIn(path.dirname(transcript), 't.jsonl', `{"type":"summary"}\n${JSON.stringify({ type: 'user', cwd: under })}\n`);
    const gone = path.join(launch, 'gone');
    const goneTranscript = path.join(tmp(), 'projects', claudeFolderName(gone), 't.jsonl');

    expect(transcriptNotesProject(transcript, dash, { platform: process.platform, env: {} })?.name).toBe('my_repo');
    expect(transcriptNotesProject(goneTranscript, path.join(gone, 'src'), { platform: process.platform, env: {} })).toBeNull();
  });

  it('gives a pinned session folder the project the session started in', () => {
    const repo = path.join(tmp(), 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const transcript = path.join(tmp(), 'projects', 'pinned-name', 't.jsonl');
    writeIn(path.dirname(transcript), 't.jsonl', `${JSON.stringify({ cwd: repo })}\n`);
    const env = { CLAUDE_CONFIG_DIR: tmp(), CLAUDE_CODE_PROJECT_DIR_NAME: 'pinned-name' };

    expect(transcriptNotesProject(transcript, tmp(), { platform: process.platform, env })?.name).toBe('repo');
    expect(transcriptNotesProject(transcript, tmp(), { platform: process.platform, env: {} })).toBeNull();
  });

  it('lists nothing for a project scope without a project root or name', () => {
    expect(claudeCodeAdapter.list(ctxOf(tmp()), 'project').containers).toEqual([]);
  });
});

describe('claudeCodeAdapter user folder from autoMemoryDirectory', () => {
  function withSettingsText(home: string, text: string, env: Record<string, string> = {}) {
    const config = env.CLAUDE_CONFIG_DIR ?? configOf(home);
    writeIn(config, 'settings.json', text);
    return claudeCodeAdapter.list(ctxOf(home, { env }), 'user');
  }
  const withSettings = (home: string, settings: JsonObject, env: Record<string, string> = {}) =>
    withSettingsText(home, JSON.stringify(settings), env);

  it('reads an absolute folder, and keeps it out of the project scope', () => {
    const home = tmp();
    const notes = path.join(tmp(), 'notes');
    writeIn(notes, 'a.md', note('A user note that applies to every project.'));

    const listing = withSettings(home, { autoMemoryDirectory: notes });
    expect(listing.warnings).toEqual([]);
    expect(listing.containers).toHaveLength(1);
    expect(listing.containers[0]).toMatchObject({ scope: 'user', path: notes, readable: true, textKeyed: false });
    expect(listing.containers[0].items.map((i) => i.key)).toEqual(['a.md']);
    expect(claudeCodeAdapter.list(ctxOf(home), 'project').containers).toEqual([]);
  });

  it('expands ~/ and ~\\ against the injected home', () => {
    const home = tmp();
    writeIn(path.join(home, 'notes'), 'a.md', note('A user note kept under the home folder.'));
    for (const value of ['~/notes', '~\\notes']) {
      expect(withSettings(home, { autoMemoryDirectory: value }).containers.map((c) => norm(c.path))).toEqual([norm(path.join(home, 'notes'))]);
    }
  });

  it('ignores a relative value with one warning', () => {
    const home = tmp();
    writeIn(path.join(configOf(home), 'notes'), 'a.md', note('A note in a folder relative to the config.'));
    const listing = withSettings(home, { autoMemoryDirectory: 'notes' });
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toHaveLength(1);
    expect(listing.warnings[0]).toContain('autoMemoryDirectory');
  });

  it('warns once on malformed JSON and lists nothing', () => {
    const listing = withSettingsText(tmp(), '{ "autoMemoryDirectory": ');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toHaveLength(1);
    expect(listing.warnings[0]).toContain('settings.json');
  });

  it('gives no container and no warning for a missing settings file, a missing folder or another value type', () => {
    const home = tmp();
    expect(claudeCodeAdapter.list(ctxOf(home), 'user')).toMatchObject({ containers: [], warnings: [] });
    expect(withSettings(home, { autoMemoryDirectory: path.join(tmp(), 'absent') })).toMatchObject({ containers: [], warnings: [] });
    expect(withSettings(home, { autoMemoryDirectory: 5 })).toMatchObject({ containers: [], warnings: [] });
  });

  it('reads settings.json from CLAUDE_CONFIG_DIR and never from the project', () => {
    const home = tmp();
    const cfg = path.join(tmp(), 'cfg');
    const decoy = path.join(tmp(), 'decoy');
    const real = path.join(tmp(), 'real');
    writeIn(decoy, 'd.md', note('A note in the folder a decoy setting names.'));
    writeIn(real, 'r.md', note('A note in the folder the config setting names.'));
    writeIn(configOf(home), 'settings.json', JSON.stringify({ autoMemoryDirectory: decoy }));
    const project = tmp();
    writeIn(path.join(project, '.claude'), 'settings.json', JSON.stringify({ autoMemoryDirectory: decoy }));
    writeIn(cfg, 'settings.json', JSON.stringify({ autoMemoryDirectory: real }));

    const listing = claudeCodeAdapter.list(ctxOf(home, { projectRoot: project, env: { CLAUDE_CONFIG_DIR: cfg } }), 'user');
    expect(listing.containers.map((c) => norm(c.path))).toEqual([norm(real)]);
    expect(claudeCodeAdapter.list(ctxOf(home, { projectRoot: project }), 'user').containers.map((c) => norm(c.path))).toEqual([norm(decoy)]);
  });
});

describe('claudeCodeAdapter items', () => {
  const containerIn = (dir: string): Container => {
    return claudeTranscriptListing(ctxOf(tmp()), path.join(path.dirname(dir), 't.jsonl')).containers[0];
  };
  const memoryDir = () => path.join(tmp(), 'projects', 'p', 'memory');

  it('reads top-level .md notes with frontmatter, except MEMORY.md, and trims the body', () => {
    const dir = memoryDir();
    writeIn(dir, 'a.md', note('  Body of the first note.  ', 'modified: "2026-03-01T10:00:00Z"'));
    writeIn(dir, 'b.md', '---\r\nname: b\r\n---\r\nBody of the second note.\r\n');
    writeIn(dir, 'MEMORY.md', note('An index, not a note.'));
    writeIn(dir, 'plain.md', 'No frontmatter here, so this is no note.');
    writeIn(dir, 'notes.txt', note('Not a markdown file.'));
    writeIn(dir, 'sub/deep.md', note('Nested notes are not read.'));
    writeIn(dir, '.hidden.md', note('Dot entries are not read.'));
    const mtime = new Date('2026-02-01T00:00:00Z');
    fs.utimesSync(path.join(dir, 'b.md'), mtime, mtime);

    const container = containerIn(dir);
    expect(container).toMatchObject({ scope: 'project', readable: true, skipped: [], warnings: [], textKeyed: false });
    expect(container.items).toEqual([
      { key: 'a.md', text: 'Body of the first note.', updatedAt: Date.parse('2026-03-01T10:00:00Z') },
      { key: 'b.md', text: 'Body of the second note.', updatedAt: mtime.getTime() },
    ]);
  });

  it('falls back to mtime for an unparsable modified and caps a future one at now', () => {
    const dir = memoryDir();
    writeIn(dir, 'bad.md', note('A note with a broken date.', 'modified: sometime soon'));
    writeIn(dir, 'future.md', note('A note dated far ahead.', 'modified: 2999-01-01T00:00:00Z'));
    const mtime = new Date('2026-01-15T00:00:00Z');
    fs.utimesSync(path.join(dir, 'bad.md'), mtime, mtime);

    const before = Date.now();
    const [bad, future] = containerIn(dir).items;
    expect(bad.updatedAt).toBe(mtime.getTime());
    expect(future.updatedAt).toBeGreaterThanOrEqual(before);
    expect(future.updatedAt).toBeLessThanOrEqual(Date.now());
  });

  it('puts a NUL-byte file and an oversize file in skipped with a warning each, not in items', () => {
    const dir = memoryDir();
    writeIn(dir, 'ok.md', note('A readable note next to two refused files.'));
    writeIn(dir, 'nul.md', note('Binary\0inside'));
    writeIn(dir, 'big.md', note('x'.repeat(256 * 1024 + 1)));

    const container = containerIn(dir);
    expect(container.readable).toBe(true);
    expect(container.items.map((i) => i.key)).toEqual(['ok.md']);
    expect(container.skipped).toEqual(['big.md', 'nul.md']);
    expect(container.warnings).toHaveLength(2);
  });

  it('marks a memory path that is a file as unreadable with one warning', () => {
    const dir = memoryDir();
    writeIn(path.dirname(dir), 'memory', 'not a folder');

    const container = containerIn(dir);
    expect(container).toMatchObject({ readable: false, items: [], skipped: [] });
    expect(container.warnings).toHaveLength(1);
  });

  it('lists no container for a missing folder', () => {
    expect(claudeTranscriptListing(ctxOf(tmp()), path.join(tmp(), 'projects', 'p', 't.jsonl'))).toMatchObject({ containers: [], warnings: [] });
  });
});
