import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProjectIdentity,
  deriveOriginProject,
  clearProjectIdentityCache,
} from '../src/project-identity.js';

let tmpRoot: string;
let home: string;

function mkdirs(...segments: string[]): string {
  const p = path.join(tmpRoot, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-pid-'));
  home = mkdirs('home');
  // The global store lives in the home dir, like ~/.hippo on a real machine.
  fs.mkdirSync(path.join(home, '.hippo'), { recursive: true });
  clearProjectIdentityCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveProjectIdentity', () => {
  it('resolves a project by its .hippo directory', () => {
    const proj = mkdirs('home', 'my-app');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const id = resolveProjectIdentity(proj, { homeDir: home });
    expect(id).toEqual({ root: fs.realpathSync.native(proj), name: 'my-app', isHome: false });
  });

  it('resolves from a nested subdirectory to the nearest .hippo ancestor', () => {
    const proj = mkdirs('home', 'my-app');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const nested = mkdirs('home', 'my-app', 'src', 'deep');
    const id = resolveProjectIdentity(nested, { homeDir: home });
    expect(id.name).toBe('my-app');
    expect(id.isHome).toBe(false);
  });

  it('falls back to the git root when no .hippo exists', () => {
    const proj = mkdirs('home', 'git-only');
    fs.mkdirSync(path.join(proj, '.git'));
    const nested = mkdirs('home', 'git-only', 'src');
    const id = resolveProjectIdentity(nested, { homeDir: home });
    expect(id.name).toBe('git-only');
    expect(id.isHome).toBe(false);
  });

  it('prefers .hippo over a nearer .git', () => {
    const outer = mkdirs('home', 'mono');
    fs.mkdirSync(path.join(outer, '.hippo'));
    const inner = mkdirs('home', 'mono', 'vendored');
    fs.mkdirSync(path.join(inner, '.git'));
    const id = resolveProjectIdentity(inner, { homeDir: home });
    expect(id.name).toBe('mono');
  });

  it('treats a .git worktree FILE as a git marker', () => {
    const proj = mkdirs('home', 'wt');
    fs.writeFileSync(path.join(proj, '.git'), 'gitdir: elsewhere\n');
    const id = resolveProjectIdentity(proj, { homeDir: home });
    expect(id.name).toBe('wt');
  });

  it('home itself is never a project despite containing .hippo (the global store)', () => {
    const id = resolveProjectIdentity(home, { homeDir: home });
    expect(id.isHome).toBe(true);
    expect(id.name).toBe('');
  });

  it('a markerless directory under home resolves to the home identity', () => {
    const misc = mkdirs('home', 'documents', 'notes');
    const id = resolveProjectIdentity(misc, { homeDir: home });
    expect(id.isHome).toBe(true);
    expect(id.name).toBe('');
  });

  it('the walk from a child project does not treat home/.hippo as a project marker', () => {
    // No .hippo/.git in the project dir itself; home/.hippo must not win.
    const bare = mkdirs('home', 'bare-project');
    const id = resolveProjectIdentity(bare, { homeDir: home });
    expect(id.isHome).toBe(true);
  });

  it('a markerless directory outside home is not a project (user-global, empty name)', () => {
    const outside = mkdirs('elsewhere', 'scratch');
    const id = resolveProjectIdentity(outside, { homeDir: home, stopDir: tmpRoot });
    expect(id.isHome).toBe(false);
    expect(id.name).toBe('');
    expect(id.root).toBe(fs.realpathSync.native(outside));
  });

  it('lowercases the project name', () => {
    const proj = mkdirs('home', 'MyApp');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const id = resolveProjectIdentity(proj, { homeDir: home });
    expect(id.name).toBe('myapp');
  });

  it('caches by input path only when no test homeDir is injected', () => {
    const proj = mkdirs('home', 'cached-app');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const first = resolveProjectIdentity(proj, { homeDir: home });
    // Remove the marker; an uncached resolve must now differ.
    fs.rmdirSync(path.join(proj, '.hippo'));
    const second = resolveProjectIdentity(proj, { homeDir: home });
    expect(first.name).toBe('cached-app');
    expect(second.isHome).toBe(true);
  });

  const junctionIt = process.platform === 'win32' ? it : it.skip;
  junctionIt('resolves a junction alias to the same identity as the real path', () => {
    const proj = mkdirs('home', 'real-app');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const alias = path.join(tmpRoot, 'alias-app');
    fs.symlinkSync(proj, alias, 'junction');
    const viaAlias = resolveProjectIdentity(alias, { homeDir: home });
    const viaReal = resolveProjectIdentity(proj, { homeDir: home });
    expect(viaAlias.root).toBe(viaReal.root);
    expect(viaAlias.name).toBe('real-app');
  });
});

describe('deriveOriginProject', () => {
  it('returns the project name inside a project', () => {
    const proj = mkdirs('home', 'origin-app');
    fs.mkdirSync(path.join(proj, '.hippo'));
    expect(deriveOriginProject(proj, { homeDir: home })).toBe('origin-app');
  });

  it('returns the empty string (user-global) at or under home with no markers', () => {
    expect(deriveOriginProject(home, { homeDir: home })).toBe('');
    const misc = mkdirs('home', 'downloads');
    expect(deriveOriginProject(misc, { homeDir: home })).toBe('');
  });
});
