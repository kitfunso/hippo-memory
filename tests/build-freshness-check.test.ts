// The globalSetup check that stops a run when dist is older than src.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { staleSources } from './_build-freshness.js';

const BUILT_AT = new Date('2026-01-02T00:00:00.000Z');
const BEFORE = new Date('2026-01-01T00:00:00.000Z');
const AFTER = new Date('2026-01-03T00:00:00.000Z');

let tree: string;

function put(rel: string, mtime: Date): void {
  const file = join(tree, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '');
  utimesSync(file, mtime, mtime);
}

const stale = (): string[] => staleSources(join(tree, 'src'), join(tree, 'dist'));

beforeEach(() => {
  tree = mkdtempSync(join(tmpdir(), 'hippo-build-freshness-'));
  put('src/cli.ts', BEFORE);
  put('dist/cli.js', BUILT_AT);
  put('src/store/open.ts', BEFORE);
  put('dist/store/open.js', BUILT_AT);
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe('staleSources', () => {
  it('passes a build newer than every source file', () => {
    expect(stale()).toEqual([]);
  });

  it('passes a source file saved in the same instant as its output', () => {
    put('src/cli.ts', BUILT_AT);
    expect(stale()).toEqual([]);
  });

  it('names a nested source file edited after the build', () => {
    put('src/store/open.ts', AFTER);
    expect(stale()).toEqual(['store/open.ts']);
  });

  it('names a source file the build has no output for', () => {
    put('src/server/routes/new-route.ts', BEFORE);
    expect(stale()).toEqual(['server/routes/new-route.ts']);
  });

  it('lists every stale file, sorted, and ignores files that are not TypeScript', () => {
    put('src/store/open.ts', AFTER);
    put('src/cli.ts', AFTER);
    put('src/notes.md', AFTER);
    expect(stale()).toEqual(['cli.ts', 'store/open.ts']);
  });
});
