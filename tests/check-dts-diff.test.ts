import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-dts-diff.mjs');

type Tree = Record<string, string>;
const roots: string[] = [];

function write(root: string, tree: Tree): void {
  for (const [file, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

/** Writes `before` and `dist` side by side in a temp dir and runs the script from there, as `npm run check:dts` would. */
function run(before: Tree, dist: Tree, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'hippo-dts-diff-'));
  roots.push(root);
  write(join(root, 'before'), before);
  write(join(root, 'dist'), dist);
  const r = spawnSync(process.execPath, [SCRIPT, '--before', join(root, 'before'), ...extra], { cwd: root, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('check-dts-diff', () => {
  it('lists an added name and exits 0', () => {
    const r = run(
      { 'index.d.ts': 'export declare function keep(): void;\n' },
      { 'index.d.ts': 'export declare function keep(): void;\nexport declare function fresh(): void;\n' },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('index.d.ts\n  + fresh\n');
    expect(r.out).toContain('check-dts-diff: 1 files compared, 1 names added, 0 removed');
  });

  it('lists a removed name, exits 1 and says how to allow it', () => {
    const r = run(
      { 'index.d.ts': 'export declare const keep: 1;\nexport declare const gone: 2;\n' },
      { 'index.d.ts': 'export declare const keep: 1;\n' },
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('  - gone\n');
    expect(r.out).toContain('0 names added, 1 removed');
    expect(r.err).toContain('--allow-removed');
  });

  it('--allow-removed still prints the removed name but exits 0', () => {
    const r = run(
      { 'index.d.ts': 'export declare const gone: 2;\n' },
      { 'index.d.ts': 'export {};\n' },
      ['--allow-removed'],
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('  - gone\n');
  });

  it('reads declarations, named lists, star re-exports and default, and skips comments and namespace members', () => {
    const after = [
      '/** export declare const inComment: 1; */',
      '// export declare const inLine: 1;',
      'export declare function fn(): void;',
      'export declare abstract class Base {}',
      'export interface Shape { a: 1 }',
      "export type Alias = 'a';",
      'export declare const enum Mode { A = 0 }',
      "export { one, type Two, three as four } from './x.js';",
      'export type {',
      '  Multi,',
      '  Line as Renamed,',
      "} from './y.js';",
      "export * from './all.js';",
      "export * as ns from './ns.js';",
      'export declare namespace Box {',
      '    export const inner: 1;',
      '}',
      'declare const _default: 1;',
      'export default _default;',
      '',
    ].join('\n');
    const r = run({ 'index.d.ts': 'export {};\n' }, { 'index.d.ts': after });
    const added = r.out.split('\n').filter((l) => l.startsWith('  + ')).map((l) => l.slice(4));
    expect(added.sort()).toEqual([
      "* from './all.js'", 'Alias', 'Base', 'Box', 'Mode', 'Multi', 'Renamed', 'Shape', 'default', 'fn', 'four', 'ns', 'one', 'Two',
    ].sort());
    expect(r.status).toBe(0);
  });

  it('compares entry/*.d.ts and nested index.d.ts, and ignores other files', () => {
    const r = run(
      { 'entry/testing.d.ts': 'export declare const a: 1;\n', 'store/index.d.ts': 'export declare const s: 1;\n', 'core/memory.d.ts': 'export declare const m: 1;\n' },
      { 'entry/testing.d.ts': 'export declare const a: 1;\nexport declare const b: 1;\n', 'store/index.d.ts': 'export declare const s: 1;\n', 'core/memory.d.ts': 'export {};\n' },
    );
    expect(r.status).toBe(0);
    expect(r.out).toContain('entry/testing.d.ts\n  + b\n');
    expect(r.out).not.toContain('core/memory.d.ts');
    expect(r.out).toContain('2 files compared, 1 names added, 0 removed');
  });

  it('counts every name of a file missing from dist as removed', () => {
    const r = run(
      { 'entry/store-kit.d.ts': 'export declare const x: 1;\nexport declare const y: 1;\n', 'index.d.ts': 'export {};\n' },
      { 'index.d.ts': 'export {};\n' },
    );
    expect(r.status).toBe(1);
    expect(r.out).toContain('entry/store-kit.d.ts\n  - x\n  - y\n');
  });

  it('exits 2 with a usage line when --before is missing, and when a tree is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-dts-diff-'));
    roots.push(root);
    const noArgs = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8' });
    expect(noArgs.status).toBe(2);
    expect(noArgs.stderr).toContain('usage:');
    const noTree = spawnSync(process.execPath, [SCRIPT, '--before', join(root, 'nope')], { cwd: root, encoding: 'utf8' });
    expect(noTree.status).toBe(2);
    expect(noTree.stderr).toContain('does not exist');
  });
});
