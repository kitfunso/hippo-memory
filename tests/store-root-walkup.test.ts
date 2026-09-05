// Ancestor walk-up store discovery (episode 01M1S8SZH6KZA9FPC9KY92XX5Y). Real filesystem
// in a mkdtemp sandbox; the CLI cases use the real home bound, hence the beforeAll guard.
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getHippoRoot, isInitialized } from '../src/store.js';
import { findHippoStoreDir } from '../src/project-identity.js';
import { findHippoRoot } from '../src/mcp/server.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hippoBin = path.join(repoRoot, 'bin', 'hippo.js');

let tmpRoot: string;
let home: string;

function mkdirs(...segments: string[]): string {
  const p = path.join(tmpRoot, ...segments);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

beforeAll(() => {
  const hits: string[] = [];
  let dir = os.tmpdir();
  while (!samePath(dir, os.homedir())) {
    if (fs.existsSync(path.join(dir, '.hippo'))) hits.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  expect(hits, 'an ancestor of os.tmpdir() holds .hippo; sandbox stores would resolve upward').toEqual([]);
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-walkup-'));
  home = mkdirs('home');
  fs.mkdirSync(path.join(home, '.hippo'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getHippoRoot ancestor walk', () => {
  it('resolves a nested subdirectory to the nearest ancestor .hippo directory', () => {
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const deep = mkdirs('home', 'proj', 'src', 'deep');
    expect(getHippoRoot(deep, { homeDir: home })).toBe(path.join(proj, '.hippo'));
  });

  it('does not look above stopDir and falls back to <cwd>/.hippo', () => {
    const outer = mkdirs('home', 'outer');
    fs.mkdirSync(path.join(outer, '.hippo'));
    const stop = mkdirs('home', 'outer', 'inner');
    const leaf = mkdirs('home', 'outer', 'inner', 'leaf');
    expect(getHippoRoot(leaf, { homeDir: home, stopDir: stop })).toBe(path.join(leaf, '.hippo'));
  });

  it('never returns the store inside the home directory itself', () => {
    const work = mkdirs('home', 'work', 'sub');
    expect(getHippoRoot(work, { homeDir: home })).toBe(path.join(work, '.hippo'));
  });

  it('ignores a stray FILE named .hippo on an ancestor', () => {
    const proj = mkdirs('home', 'proj');
    fs.writeFileSync(path.join(proj, '.hippo'), 'not a store');
    const leaf = mkdirs('home', 'proj', 'src');
    expect(findHippoStoreDir(leaf, { homeDir: home })).toBeNull();
    expect(getHippoRoot(leaf, { homeDir: home })).toBe(path.join(leaf, '.hippo'));
  });

  it('returns <cwd>/.hippo when no marker exists anywhere up to the bound', () => {
    const lone = mkdirs('elsewhere', 'a', 'b');
    expect(getHippoRoot(lone, { homeDir: home, stopDir: tmpRoot })).toBe(path.join(lone, '.hippo'));
  });

  it('ends the walk at the temp root unchecked, so a sandbox under it never resolves upward', () => {
    const tmp = mkdirs('scratch', 'tmp');
    fs.mkdirSync(path.join(tmpRoot, 'scratch', '.hippo'));
    const work = mkdirs('scratch', 'tmp', 'work');
    expect(findHippoStoreDir(work, { homeDir: home })).toBe(path.join(tmpRoot, 'scratch', '.hippo'));

    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = tmp;
    process.env.TEMP = tmp;
    process.env.TMP = tmp;
    try {
      expect(samePath(fs.realpathSync.native(os.tmpdir()), fs.realpathSync.native(tmp))).toBe(true);
      expect(findHippoStoreDir(work, { homeDir: home })).toBeNull();
      expect(getHippoRoot(work, { homeDir: home })).toBe(path.join(work, '.hippo'));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('returns a bare ancestor .hippo directory, which isInitialized then rejects', () => {
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const src = mkdirs('home', 'proj', 'src');
    const root = getHippoRoot(src, { homeDir: home });
    expect(root).toBe(path.join(proj, '.hippo'));
    expect(isInitialized(root)).toBe(false);
  });
});

describe('CLI end to end', () => {
  it('recall from <proj>/src finds the project store and creates no nested one', () => {
    const globalStore = mkdirs('global-store');
    const env = { ...process.env, HIPPO_HOME: globalStore };
    const proj = mkdirs('home', 'proj');
    const src = mkdirs('home', 'proj', 'src');
    const cliOpts = { env, encoding: 'utf-8' as const };

    execFileSync('node', [hippoBin, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: proj, ...cliOpts });
    execFileSync('node', [hippoBin, 'remember', 'walkup-target zeta fact'], { cwd: proj, ...cliOpts });
    const out = execFileSync('node', [hippoBin, 'recall', 'walkup-target'], { cwd: src, ...cliOpts });
    expect(out).toContain('walkup-target');
    expect(fs.existsSync(path.join(src, '.hippo'))).toBe(false);

    const again = execFileSync('node', [hippoBin, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: src, ...cliOpts });
    expect(again).toContain('Already initialized at');
    expect(fs.existsSync(path.join(src, '.hippo'))).toBe(false);
  });

  it('a directory with no store anywhere up to home still fails, naming both paths', () => {
    const globalStore = mkdirs('global-store');
    const lone = mkdirs('lone');
    const res = spawnSync('node', [hippoBin, 'recall', 'anything'], {
      cwd: lone,
      env: { ...process.env, HIPPO_HOME: globalStore },
      encoding: 'utf-8',
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('No hippo store at');
    expect(res.stderr).toContain(path.join(lone, '.hippo'));
    expect(res.stderr).toContain('up to your home directory');
    expect(fs.existsSync(path.join(lone, '.hippo'))).toBe(false);
  });
});

describe('MCP findHippoRoot', () => {
  const origHippoHome = process.env.HIPPO_HOME;

  afterEach(() => {
    if (origHippoHome === undefined) delete process.env.HIPPO_HOME;
    else process.env.HIPPO_HOME = origHippoHome;
  });

  it('HIPPO_HOME wins over home/.hippo when cwd is under home with no marker', () => {
    const globalStore = mkdirs('global-store');
    process.env.HIPPO_HOME = globalStore;
    const work = mkdirs('home', 'work');
    expect(findHippoRoot(work, { homeDir: home })).toBe(globalStore);
  });

  it('returns null when no ancestor store exists and the global root is missing', () => {
    process.env.HIPPO_HOME = path.join(tmpRoot, 'missing-global');
    const work = mkdirs('home', 'work');
    expect(findHippoRoot(work, { homeDir: home })).toBeNull();
  });

  it('prefers the nearest ancestor store over the global root', () => {
    const globalStore = mkdirs('global-store');
    process.env.HIPPO_HOME = globalStore;
    const proj = mkdirs('home', 'proj');
    fs.mkdirSync(path.join(proj, '.hippo'));
    const src = mkdirs('home', 'proj', 'src');
    expect(findHippoRoot(src, { homeDir: home })).toBe(path.join(proj, '.hippo'));
  });
});
