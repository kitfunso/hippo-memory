import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveProjectIdentity,
  deriveOriginProject,
  clearProjectIdentityCache,
  assertCallerProject,
  MAX_PROJECT_ALIASES,
} from '../src/core/project-identity.js';
import { BadRequestError } from '../src/core/api-errors.js';
import { MAX_ID_LEN } from '../src/util/limits.js';

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
    expect(id).toEqual({ root: fs.realpathSync.native(proj), name: 'my-app', legacyName: 'my-app', isHome: false });
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

  it('names a linked worktree after its main checkout, so worktrees share one project', () => {
    const main = mkdirs('home', 'repo');
    const link = mkdirs('home', 'repo', '.git', 'worktrees', 'repo-wt');
    fs.writeFileSync(path.join(link, 'commondir'), '../..\n');
    const wt = mkdirs('home', 'repo-wt');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${link}\n`);
    const id = resolveProjectIdentity(mkdirs('home', 'repo-wt', 'src'), { homeDir: home });
    expect(id).toEqual({ root: fs.realpathSync.native(wt), name: 'repo', legacyName: 'repo', isHome: false });
    expect(resolveProjectIdentity(main, { homeDir: home }).name).toBe('repo');
  });

  it('follows a relative gitdir, and names a bare repo worktree after the repo without .git', () => {
    const link = mkdirs('home', 'tool.git', 'worktrees', 'main');
    fs.writeFileSync(path.join(link, 'commondir'), '../..\n');
    const wt = mkdirs('home', 'tool-main');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.relative(wt, link)}\n`);
    expect(resolveProjectIdentity(wt, { homeDir: home }).name).toBe('tool');
  });

  it('keeps the name of a worktree that has its own .hippo store, since its rows carry that name', () => {
    const link = mkdirs('home', 'repo', '.git', 'worktrees', 'repo-wt');
    fs.writeFileSync(path.join(link, 'commondir'), '../..\n');
    const wt = mkdirs('home', 'repo-wt');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${link}\n`);
    fs.mkdirSync(path.join(wt, '.hippo'));
    expect(resolveProjectIdentity(wt, { homeDir: home }).name).toBe('repo-wt');
  });

  it('keeps a submodule, whose git dir has no commondir, as its own project', () => {
    const modDir = mkdirs('home', 'parent', '.git', 'modules', 'sub');
    const sub = mkdirs('home', 'parent', 'sub');
    fs.writeFileSync(path.join(sub, '.git'), `gitdir: ${path.relative(sub, modDir)}\n`);
    expect(resolveProjectIdentity(sub, { homeDir: home }).name).toBe('sub');
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

  it('ends the walk at the temp root unchecked, so markers above it never name a sandbox', () => {
    const tmp = mkdirs('outer', 'tmp');
    fs.mkdirSync(path.join(tmpRoot, 'outer', '.hippo'));
    fs.mkdirSync(path.join(tmpRoot, 'outer', '.git'));
    const plain = mkdirs('outer', 'tmp', 'plain');
    const repo = mkdirs('outer', 'tmp', 'repo');
    fs.mkdirSync(path.join(repo, '.git'));
    expect(resolveProjectIdentity(plain, { homeDir: home }).name).toBe('outer');

    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = tmp;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
    try {
      expect(resolveProjectIdentity(plain, { homeDir: home }).name).toBe('');
      expect(resolveProjectIdentity(repo, { homeDir: home }).name).toBe('repo');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
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

describe('assertCallerProject', () => {
  const aliases = (n: number): string[] => Array.from({ length: n }, (_, i) => `alias-${i}`);

  it('refuses a blank name, too many aliases and an overlong name or alias', () => {
    for (const project of [
      { name: '' },
      { name: '   ' },
      { name: 'acme/app', aliases: aliases(MAX_PROJECT_ALIASES + 1) },
      { name: 'x'.repeat(MAX_ID_LEN + 1) },
      { name: 'acme/app', aliases: ['y'.repeat(MAX_ID_LEN + 1)] },
    ]) {
      expect(() => assertCallerProject(project), JSON.stringify(project).slice(0, 60)).toThrow(BadRequestError);
    }
  });

  it('accepts a name with up to ten aliases', () => {
    expect(MAX_PROJECT_ALIASES).toBe(10);
    expect(() => assertCallerProject({ name: 'acme/app', aliases: aliases(10) })).not.toThrow();
    expect(() => assertCallerProject({ name: 'x'.repeat(MAX_ID_LEN) })).not.toThrow();
  });

  it('refuses a name or alias with capitals, padding, a colon or a control character rather than rewriting it', () => {
    for (const project of [
      { name: 'Acme/App' },
      { name: ' acme/app' },
      { name: 'acme/app ' },
      { name: 'acme:app' },
      { name: 'acme\napp' },
      { name: 'acme/app', aliases: ['App'] },
      { name: 'acme/app', aliases: ['a:b'] },
      { name: 'acme/app', aliases: ['a\tb'] },
    ]) {
      expect(() => assertCallerProject(project), JSON.stringify(project)).toThrow(BadRequestError);
    }
  });

  it('accepts the names the resolver gives: a remote id, a project file id, a folder name', () => {
    expect(() => assertCallerProject({ name: 'github.com/acme/app', aliases: ['acme-app', 'app'] })).not.toThrow();
    expect(() => assertCallerProject({ name: 'dev.azure.com/org/proj/repo', aliases: ['repo_1.2'] })).not.toThrow();
    expect(() => assertCallerProject({ name: 'my app' })).not.toThrow();
  });
});
