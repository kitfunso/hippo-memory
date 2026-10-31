// Z0 stage 2 pins: the dist tree hash, the hippo build a record names, and the --pins refusal.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { treeHash, hippoBuild, pinMismatches, claudePinned, refuseOffPins } from '../scripts/token-eval/pins.mjs';

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true, maxRetries: 5 });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'z0-pins-'));
  dirs.push(d);
  return d;
};
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

describe('treeHash', () => {
  it('moves with a byte or a path and stays put for the same tree', () => {
    const a = tmp();
    write(a, 'cli.js', 'x');
    write(a, 'store/open.js', 'y');
    const b = tmp();
    write(b, 'store/open.js', 'y');
    write(b, 'cli.js', 'x');
    const first = treeHash(a);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(treeHash(b)).toBe(first);
    write(a, 'cli.js', 'z');
    expect(treeHash(a)).not.toBe(first);
    write(a, 'cli.js', 'x');
    renameSync(join(a, 'store', 'open.js'), join(a, 'store', 'opened.js'));
    expect(treeHash(a)).not.toBe(first);
  });
});

describe('hippoBuild', () => {
  it('names the commit and dist hash, and reads dirty once the tree differs from the commit', () => {
    const repo = tmp();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('config', 'commit.gpgsign', 'false');
    write(repo, 'dist/cli.js', 'built');
    git('add', '.');
    git('commit', '-qm', 'base');
    const clean = hippoBuild(repo);
    expect(clean).toEqual({ hippoCommit: git('rev-parse', 'HEAD'), hippoDirty: false, hippoDistHash: treeHash(join(repo, 'dist')) });
    write(repo, 'src/new.ts', 'untracked');
    expect(hippoBuild(repo).hippoDirty).toBe(true);
  });
});

describe('the --pins check', () => {
  const build = { hippoCommit: 'c'.repeat(40), hippoDirty: false, hippoDistHash: 'd'.repeat(64) };
  const ctx = { claudeVersion: '2.1.288 (Claude Code)', model: 'claude-sonnet-5-5', hippoBuild: build };
  const pins = { claudeVersion: '2.1.288', model: 'claude-sonnet-5-5', hippoCommit: build.hippoCommit, hippoDistHash: build.hippoDistHash };

  it('pins Claude Code by its version token and passes a run that matches', () => {
    expect(claudePinned(ctx)).toEqual(pins);
    expect(() => refuseOffPins(pins, claudePinned(ctx), ctx)).not.toThrow();
  });

  it('names each difference and each key the pins file lacks', () => {
    const partial = { claudeVersion: pins.claudeVersion, model: 'claude-opus-5-5', hippoCommit: pins.hippoCommit };
    expect(pinMismatches(partial, claudePinned(ctx))).toEqual([
      'model is pinned claude-opus-5-5, this run has claude-sonnet-5-5', 'hippoDistHash is not pinned',
    ]);
  });

  it('refuses a dirty checkout even when every pin matches, and checks nothing without a pins file', () => {
    const dirty = { ...ctx, hippoBuild: { ...build, hippoDirty: true } };
    expect(() => refuseOffPins(pins, claudePinned(dirty), dirty)).toThrow(/differs from --pins: the hippo checkout has changes beyond its commit/);
    expect(() => refuseOffPins(null, claudePinned(dirty), dirty)).not.toThrow();
  });
});
