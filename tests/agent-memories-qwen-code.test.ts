/**
 * Qwen Code adapter: base folder precedence, project keys, local scope and the note rules.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qwenCodeAdapter, sanitizeCwd } from '../src/agent-memories/qwen-code.js';
import type { AdapterContext, Scope } from '../src/agent-memories/types.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-am-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(file: string, content: string | Buffer = 'a note about the build'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function ctxOf(env: Record<string, string>, projectRoot?: string, platform: NodeJS.Platform = process.platform): AdapterContext {
  return { home: tmp, env, platform, projectRoot };
}

const list = (ctx: AdapterContext, scope: Scope) => qwenCodeAdapter.list(ctx, scope);

describe('sanitizeCwd', () => {
  it('turns every non-alphanumeric into a dash and keeps case off win32', () => {
    expect(sanitizeCwd('/Home/x_y/my proj.v2', 'linux')).toBe('-Home-x-y-my-proj-v2');
  });

  it('lowercases first on win32', () => {
    expect(sanitizeCwd('C:\\Users\\Kit\\Proj', 'win32')).toBe('c--users-kit-proj');
  });

  it('has no length cap', () => {
    expect(sanitizeCwd('/a'.repeat(300), 'linux')).toHaveLength(600);
  });
});

describe('qwen-code base folder', () => {
  it('follows QWEN_CODE_MEMORY_BASE_DIR, then QWEN_RUNTIME_DIR, then QWEN_HOME, then <home>/.qwen', () => {
    const keys = ['QWEN_CODE_MEMORY_BASE_DIR', 'QWEN_RUNTIME_DIR', 'QWEN_HOME'] as const;
    const dirs = {
      QWEN_CODE_MEMORY_BASE_DIR: path.join(tmp, 'base'),
      QWEN_RUNTIME_DIR: path.join(tmp, 'runtime'),
      QWEN_HOME: path.join(tmp, 'qhome'),
    };
    const fallback = path.join(tmp, '.qwen');
    for (const dir of [...Object.values(dirs), fallback]) write(path.join(dir, 'memories', 'n.md'), `from ${dir}`);

    for (let i = 0; i <= keys.length; i++) {
      const env = Object.fromEntries(keys.slice(i).map((key) => [key, dirs[key]]));
      const expected = i < keys.length ? dirs[keys[i]] : fallback;
      const listing = list(ctxOf(env), 'user');
      expect(listing.home).toBe(expected);
      expect(listing.containers.map((c) => c.path)).toEqual([path.join(expected, 'memories')]);
      expect(listing.containers[0].items[0].text).toBe(`from ${expected}`);
    }
  });

  it('ignores an empty variable', () => {
    write(path.join(tmp, '.qwen', 'memories', 'n.md'));
    expect(list(ctxOf({ QWEN_CODE_MEMORY_BASE_DIR: '' }), 'user').home).toBe(path.join(tmp, '.qwen'));
  });

  it('returns no container and no warning when the folder is missing', () => {
    const listing = list(ctxOf({}), 'user');
    expect(listing.containers).toEqual([]);
    expect(listing.warnings).toEqual([]);
  });
});

describe('qwen-code project container', () => {
  const base = (): string => path.join(tmp, '.qwen');
  const projectDirFor = (key: string): string => path.join(base(), 'projects', sanitizeCwd(key, process.platform), 'memory');

  it('is not listed without a project root, and the user scope never lists it', () => {
    write(path.join(projectDirFor(path.join(tmp, 'proj')), 'n.md'));
    write(path.join(base(), 'memories', 'u.md'));
    expect(list(ctxOf({}), 'project').containers).toEqual([]);
    const user = list(ctxOf({}, path.join(tmp, 'proj')), 'user');
    expect(user.containers.map((c) => c.scope)).toEqual(['user']);
  });

  it('keys by the nearest folder holding a .git folder', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const deep = path.join(repo, 'src', 'deep');
    fs.mkdirSync(deep, { recursive: true });
    write(path.join(projectDirFor(repo), 'n.md'));
    const container = list(ctxOf({}, deep), 'project').containers[0];
    expect(container.path).toBe(projectDirFor(repo));
    expect(container.scope).toBe('project');
  });

  it('lets a linked worktree with a .git file keep its own key', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const worktree = path.join(repo, 'wt');
    write(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/wt');
    const inside = path.join(worktree, 'src');
    fs.mkdirSync(inside, { recursive: true });
    write(path.join(projectDirFor(worktree), 'n.md'));
    write(path.join(projectDirFor(repo), 'other.md'));
    expect(list(ctxOf({}, inside), 'project').containers[0].path).toBe(projectDirFor(worktree));
  });

  it('keys by the resolved project root when no .git is above it', () => {
    const root = path.join(tmp, 'plain', 'proj');
    fs.mkdirSync(root, { recursive: true });
    write(path.join(projectDirFor(root), 'n.md'));
    expect(list(ctxOf({}, path.join(root, '..', 'proj')), 'project').containers[0].path).toBe(projectDirFor(root));
  });

  it('keys by the project root itself when QWEN_CODE_MEMORY_PROJECT_SCOPE is workspace', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const sub = path.join(repo, 'pkg');
    fs.mkdirSync(sub, { recursive: true });
    write(path.join(projectDirFor(sub), 'n.md'));
    write(path.join(projectDirFor(repo), 'other.md'));
    const listing = list(ctxOf({ QWEN_CODE_MEMORY_PROJECT_SCOPE: 'workspace' }, sub), 'project');
    expect(listing.containers.map((c) => c.path)).toEqual([projectDirFor(sub)]);
  });

  it('uses <projectRoot>/.qwen/memory when QWEN_CODE_MEMORY_LOCAL is 1', () => {
    const root = path.join(tmp, 'proj');
    write(path.join(root, '.qwen', 'memory', 'n.md'), 'local note');
    write(path.join(projectDirFor(root), 'n.md'), 'shared note');
    const listing = list(ctxOf({ QWEN_CODE_MEMORY_LOCAL: '1' }, root), 'project');
    expect(listing.containers.map((c) => c.path)).toEqual([path.join(root, '.qwen', 'memory')]);
    expect(listing.containers[0].items.map((i) => i.text)).toEqual(['local note']);
  });

  it('does not treat other QWEN_CODE_MEMORY_LOCAL values as local', () => {
    const root = path.join(tmp, 'proj');
    write(path.join(root, '.qwen', 'memory', 'n.md'));
    expect(list(ctxOf({ QWEN_CODE_MEMORY_LOCAL: 'true' }, root), 'project').containers).toEqual([]);
  });

  it('lowercases the key on win32 before making the folder name', () => {
    const root = path.join(tmp, 'Mixed', 'Proj');
    fs.mkdirSync(root, { recursive: true });
    const dir = path.join(base(), 'projects', sanitizeCwd(root, 'win32'), 'memory');
    write(path.join(dir, 'n.md'));
    const listing = list(ctxOf({}, root, 'win32'), 'project');
    expect(sanitizeCwd(root, 'win32')).not.toBe(sanitizeCwd(root, 'linux'));
    expect(listing.containers.map((c) => c.path)).toEqual([dir]);
  });
});

describe('qwen-code items', () => {
  const memories = (): string => path.join(tmp, '.qwen', 'memories');

  it('reads notes at any depth with their path as key, mtime as time and frontmatter stripped', () => {
    const when = Date.UTC(2026, 0, 2, 3, 4, 5);
    const files = [
      write(path.join(memories(), 'plain.md'), '  Prefer pnpm.  \n'),
      write(path.join(memories(), 'fm.md'), '---\nname: x\ndescription: y\n---\nUse tabs in Makefiles.\n'),
      write(path.join(memories(), 'pinned', 'always.md'), 'Never force push.'),
      write(path.join(memories(), 'a', 'b', 'deep.md'), 'Deep note.'),
    ];
    for (const f of files) fs.utimesSync(f, new Date(when), new Date(when));
    write(path.join(memories(), 'notes.txt'), 'not markdown');

    const container = list(ctxOf({}), 'user').containers[0];
    expect(container.readable).toBe(true);
    expect(container.textKeyed).toBe(false);
    expect(container.items.map((i) => [i.key, i.text])).toEqual([
      ['a/b/deep.md', 'Deep note.'],
      ['fm.md', 'Use tabs in Makefiles.'],
      ['pinned/always.md', 'Never force push.'],
      ['plain.md', 'Prefer pnpm.'],
    ]);
    for (const item of container.items) expect(Math.round(item.updatedAt)).toBe(when);
  });

  it('skips the top-level MEMORY.md but keeps a nested one', () => {
    write(path.join(memories(), 'MEMORY.md'), '- index line');
    write(path.join(memories(), 'sub', 'MEMORY.md'), 'nested index is a note');
    const container = list(ctxOf({}), 'user').containers[0];
    expect(container.items.map((i) => i.key)).toEqual(['sub/MEMORY.md']);
  });

  it('puts a file over 256 KB or holding a NUL byte in skipped, with a warning each', () => {
    write(path.join(memories(), 'ok.md'), 'fine note');
    write(path.join(memories(), 'big.md'), 'x'.repeat(256 * 1024 + 1));
    write(path.join(memories(), 'bin.md'), Buffer.from([65, 0, 66]));
    const container = list(ctxOf({}), 'user').containers[0];
    expect(container.readable).toBe(true);
    expect(container.items.map((i) => i.key)).toEqual(['ok.md']);
    expect([...container.skipped].sort()).toEqual(['big.md', 'bin.md']);
    expect(container.warnings).toHaveLength(2);
  });

  it('reads a container that is not a folder as unreadable with one warning', () => {
    write(memories(), 'a file where the folder should be');
    const container = list(ctxOf({}), 'user').containers[0];
    expect(container.readable).toBe(false);
    expect(container.items).toEqual([]);
    expect(container.warnings).toHaveLength(1);
  });
});
