/**
 * Copilot Chat adapter: VS Code data folders per platform, user files, and workspace matching by folder URI.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copilotAdapter } from '../src/agent-memories/copilot.js';
import type { AdapterContext, Scope } from '../src/agent-memories/types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string | Buffer = 'a remembered fact'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function ctxOf(env: Record<string, string>, projectRoot?: string, platform: NodeJS.Platform = process.platform): AdapterContext {
  return { home: tmp, env, platform, projectRoot };
}

const list = (ctx: AdapterContext, scope: Scope) => copilotAdapter.list(ctx, scope);

const TOOL_DIR = path.join('github.copilot-chat', 'memory-tool', 'memories');
const userMemories = (data: string): string => path.join(data, 'User', 'globalStorage', TOOL_DIR);
const repoMemories = (data: string, id: string): string =>
  path.join(data, 'User', 'workspaceStorage', id, TOOL_DIR, 'repo');
const workspaceJson = (data: string, id: string): string =>
  path.join(data, 'User', 'workspaceStorage', id, 'workspace.json');

/** The URI VS Code writes: `file:///c%3A/Users/x` on Windows, `file:///home/x` elsewhere. */
function fileUri(p: string): string {
  const encoded = encodeURI(p.replace(/\\/g, '/'));
  return `file://${encoded.replace(/^([a-zA-Z]):/, (_m, d: string) => `/${d.toLowerCase()}%3A`)}`;
}

/** A workspace whose repo folder holds one memory file; returns the container path. */
function addWorkspace(data: string, id: string, workspaceJsonBody: string): string {
  write(path.join(repoMemories(data, id), 'note.md'), `note of ${id}`);
  write(workspaceJson(data, id), workspaceJsonBody);
  return repoMemories(data, id);
}

describe('copilot data folders', () => {
  it('uses only <VSCODE_PORTABLE>/user-data when VSCODE_PORTABLE is set', () => {
    const portable = path.join(tmp, 'portable');
    const data = path.join(portable, 'user-data');
    write(path.join(userMemories(data), 'a.md'));
    write(path.join(userMemories(path.join(tmp, 'appdata', 'Code')), 'b.md'));
    const listing = list(ctxOf({ VSCODE_PORTABLE: portable, VSCODE_APPDATA: path.join(tmp, 'appdata') }), 'user');
    expect(listing.home).toBe(data);
    expect(listing.containers.map((c) => c.path)).toEqual([userMemories(data)]);
  });

  it('uses <VSCODE_APPDATA>/<product> for both products, ahead of the platform default', () => {
    const appData = path.join(tmp, 'custom');
    const code = path.join(appData, 'Code');
    const insiders = path.join(appData, 'Code - Insiders');
    write(path.join(userMemories(code), 'a.md'));
    write(path.join(userMemories(insiders), 'b.md'));
    write(path.join(userMemories(path.join(tmp, 'roaming', 'Code')), 'c.md'));
    const env = { VSCODE_APPDATA: appData, APPDATA: path.join(tmp, 'roaming') };
    const listing = list(ctxOf(env, undefined, 'win32'), 'user');
    expect(listing.home).toBe(code);
    expect(listing.containers.map((c) => c.path)).toEqual([userMemories(code), userMemories(insiders)]);
  });

  it('names the first data folder that exists as home, else the first candidate', () => {
    const appData = path.join(tmp, 'custom');
    const env = { VSCODE_APPDATA: appData };
    expect(list(ctxOf(env), 'user').home).toBe(path.join(appData, 'Code'));
    fs.mkdirSync(path.join(appData, 'Code - Insiders'), { recursive: true });
    expect(list(ctxOf(env), 'user').home).toBe(path.join(appData, 'Code - Insiders'));
  });

  const roaming = (): string => path.join(tmp, 'roaming');
  const xdg = (): string => path.join(tmp, 'xdg');
  it.each([
    ['win32 with APPDATA', 'win32', () => ({ APPDATA: roaming() }), () => roaming()],
    ['win32 without APPDATA', 'win32', () => ({}), () => path.join(tmp, 'AppData', 'Roaming')],
    ['darwin', 'darwin', () => ({}), () => path.join(tmp, 'Library', 'Application Support')],
    ['linux with XDG_CONFIG_HOME', 'linux', () => ({ XDG_CONFIG_HOME: xdg() }), () => xdg()],
    ['linux without XDG_CONFIG_HOME', 'linux', () => ({}), () => path.join(tmp, '.config')],
    ['another platform', 'freebsd', () => ({}), () => path.join(tmp, '.config')],
  ] as const)('resolves the default on %s', (_name, platform, env, appData) => {
    const data = path.join(appData(), 'Code');
    write(path.join(userMemories(data), 'a.md'));
    const listing = list(ctxOf(env(), undefined, platform), 'user');
    expect(listing.home).toBe(data);
    expect(listing.containers.map((c) => c.path)).toEqual([userMemories(data)]);
  });
});

describe('copilot user container', () => {
  const data = (): string => path.join(tmp, 'appdata', 'Code');
  const env = () => ({ VSCODE_APPDATA: path.join(tmp, 'appdata') });

  it('reads every file at any depth: path as key, trimmed content, mtime, frontmatter left alone', () => {
    const when = Date.UTC(2026, 1, 3, 4, 5, 6);
    const files = [
      write(path.join(userMemories(data()), 'prefs.md'), '\n  Use tabs.  \n'),
      write(path.join(userMemories(data()), 'notes', 'deep', 'x.txt'), 'plain text file'),
      write(path.join(userMemories(data()), 'fm.md'), '---\nname: n\n---\nbody'),
    ];
    for (const f of files) fs.utimesSync(f, new Date(when), new Date(when));
    const container = list(ctxOf(env()), 'user').containers[0];
    expect(container.scope).toBe('user');
    expect(container.readable).toBe(true);
    expect(container.textKeyed).toBe(false);
    expect(container.items.map((i) => [i.key, i.text])).toEqual([
      ['fm.md', '---\nname: n\n---\nbody'],
      ['notes/deep/x.txt', 'plain text file'],
      ['prefs.md', 'Use tabs.'],
    ]);
    for (const item of container.items) expect(Math.round(item.updatedAt)).toBe(when);
  });

  it('puts a file over 256 KB or holding a NUL byte in skipped, with a warning each', () => {
    write(path.join(userMemories(data()), 'ok.md'), 'fine');
    write(path.join(userMemories(data()), 'big.md'), 'x'.repeat(256 * 1024 + 1));
    write(path.join(userMemories(data()), 'bin.dat'), Buffer.from([65, 0, 66]));
    const container = list(ctxOf(env()), 'user').containers[0];
    expect(container.items.map((i) => i.key)).toEqual(['ok.md']);
    expect([...container.skipped].sort()).toEqual(['big.md', 'bin.dat']);
    expect(container.warnings).toHaveLength(2);
  });

  it('reads a container that is not a folder as unreadable with one warning', () => {
    write(userMemories(data()), 'a file where the folder should be');
    const container = list(ctxOf(env()), 'user').containers[0];
    expect(container.readable).toBe(false);
    expect(container.items).toEqual([]);
    expect(container.warnings).toHaveLength(1);
  });

  it('lists nothing, with no warning, when the folder is missing', () => {
    const listing = list(ctxOf(env()), 'user');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });
});

describe('copilot project containers', () => {
  const data = (): string => path.join(tmp, 'appdata', 'Code');
  const env = () => ({ VSCODE_APPDATA: path.join(tmp, 'appdata') });
  const projectRoot = (): string => path.join(tmp, 'proj');
  const paths = (ctx: AdapterContext): string[] => list(ctx, 'project').containers.map((c) => c.path);

  it('lists nothing without a project root, and the user scope never lists project folders', () => {
    const container = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(projectRoot()) }));
    expect(paths(ctxOf(env()))).toEqual([]);
    expect(list(ctxOf(env(), projectRoot()), 'user').containers).toEqual([]);
    expect(paths(ctxOf(env(), projectRoot()))).toEqual([container]);
  });

  it('matches a workspace whose folder is exactly the project root', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    const container = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(projectRoot()) }));
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers.map((c) => [c.scope, c.path, c.items.map((i) => i.key)])).toEqual([
      ['project', container, ['note.md']],
    ]);
    expect(listing.warnings).toEqual([]);
  });

  it('decodes percent-escapes in the folder URI', () => {
    const root = path.join(tmp, 'my proj');
    fs.mkdirSync(root, { recursive: true });
    const container = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(root) }));
    expect(fileUri(root)).toContain('%20');
    expect(paths(ctxOf(env(), root))).toEqual([container]);
  });

  it('does not match a parent or a child folder of the project root', () => {
    fs.mkdirSync(path.join(projectRoot(), 'child'), { recursive: true });
    addWorkspace(data(), 'parent', JSON.stringify({ folder: fileUri(tmp) }));
    addWorkspace(data(), 'child', JSON.stringify({ folder: fileUri(path.join(projectRoot(), 'child')) }));
    expect(paths(ctxOf(env(), projectRoot()))).toEqual([]);
  });

  it("matches a workspace opened at the project's git top level", () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true });
    execFileSync('git', ['init', '-q', repo]);
    const container = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(fs.realpathSync.native(repo)) }));
    expect(paths(ctxOf(env(), path.join(repo, 'sub')))).toEqual([container]);
  });

  it('finds project containers under both products', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    const insiders = path.join(tmp, 'appdata', 'Code - Insiders');
    const a = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(projectRoot()) }));
    const b = addWorkspace(insiders, 'w9', JSON.stringify({ folder: fileUri(projectRoot()) }));
    expect(paths(ctxOf(env(), projectRoot()))).toEqual([a, b]);
  });

  it('skips a multi-root workspace', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    const workspace = fileUri(path.join(tmp, 'x.code-workspace'));
    addWorkspace(data(), 'w1', JSON.stringify({ workspace, folder: fileUri(projectRoot()) }));
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });

  it('skips a remote URI without a warning', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    const remote = `vscode-remote://ssh-remote%2Bbox${fileUri(projectRoot()).slice('file://'.length)}`;
    addWorkspace(data(), 'w1', JSON.stringify({ folder: remote }));
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });

  it.each([
    ['not JSON', '{ "folder": '],
    ['an array', '["file:///x"]'],
    ['null', 'null'],
    ['a folder that is not text', '{ "folder": 5 }'],
  ])('reports a workspace.json that is %s as one warning and skips that id', (_name, body) => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    addWorkspace(data(), 'bad', body);
    const good = addWorkspace(data(), 'good', JSON.stringify({ folder: fileUri(projectRoot()) }));
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers.map((c) => c.path)).toEqual([good]);
    expect(listing.warnings).toHaveLength(1);
    expect(listing.warnings[0]).toContain('workspace.json');
  });

  it('reads workspace.json only for ids that hold the repo folder', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    write(workspaceJson(data(), 'no-repo'), '{ broken');
    write(path.join(data(), 'User', 'workspaceStorage', 'other', TOOL_DIR, 'session', 's.md'));
    write(workspaceJson(data(), 'other'), '{ broken');
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });

  it('warns once when a repo folder has no workspace.json', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    write(path.join(repoMemories(data(), 'w1'), 'note.md'));
    const listing = list(ctxOf(env(), projectRoot()), 'project');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toHaveLength(1);
  });

  it.skipIf(process.platform !== 'win32')('compares a Windows drive URI case-insensitively on win32', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    const container = addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(projectRoot()).toLowerCase() }));
    expect(paths(ctxOf(env(), projectRoot(), 'win32'))).toEqual([container]);
  });

  it.skipIf(process.platform === 'win32')('compares case-sensitively off win32', () => {
    fs.mkdirSync(projectRoot(), { recursive: true });
    addWorkspace(data(), 'w1', JSON.stringify({ folder: fileUri(projectRoot()).toUpperCase().replace('FILE://', 'file://') }));
    expect(paths(ctxOf(env(), projectRoot(), 'linux'))).toEqual([]);
  });
});
