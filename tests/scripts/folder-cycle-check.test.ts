import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findFolderCycles } from '../../scripts/check-folder-cycles.mjs';

describe('check-folder-cycles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'folder-cycles-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('reports two folders that import each other through different files, which no file cycle shows', () => {
    file('search/rank.ts', `import { scopeOf } from '../sharing/scope.js';\nexport const rank = scopeOf;\n`);
    file('sharing/scope.ts', `export const scopeOf = 1;\n`);
    file('sharing/both.ts', `import { rank } from '../search/rank.js';\nexport const both = rank;\n`);
    file('core/x.ts', `export const x = 1;\n`);
    file(
      'cli.ts',
      `import { both } from './sharing/both.js';\nimport { x } from './core/x.js';\nexport const cli = [both, x];\n`,
    );
    expect(findFolderCycles(dir)).toEqual([
      {
        folders: ['search', 'sharing'],
        edges: [
          ['search/rank.ts', 'sharing/scope.ts'],
          ['sharing/both.ts', 'search/rank.ts'],
        ],
      },
    ]);
  });

  it('follows a multi-line import and a re-export, and skips a type-only import, a comment and a dynamic import', () => {
    file('a/one.ts', `import {\n  two,\n} from '../b/two.js';\nexport const one = two;\n`);
    file('b/two.ts', `export { one } from '../a/one.js';\nexport const two = 1;\n`);
    file(
      'c/three.ts',
      `import type { Four } from '../d/four.js';\n// import { four } from '../d/four.js';\nexport const lazy = () => import('../d/four.js');\nexport type Three = Four;\n`,
    );
    file('d/four.ts', `import { lazy } from '../c/three.js';\nexport type Four = number;\nexport const four = lazy;\n`);
    expect(findFolderCycles(dir).map((c) => c.folders)).toEqual([['a', 'b']]);
  });

  it('keys base, domain and surface on their features, so two domain features that import each other fail', () => {
    file('domain/search/rank.ts', `import { scopeOf } from '../sharing/scope.js';\nexport const rank = scopeOf;\n`);
    file('domain/sharing/scope.ts', `export const scopeOf = 1;\n`);
    file('domain/sharing/both.ts', `import { rank } from '../search/rank.js';\nexport const both = rank;\n`);
    file('db/open.ts', `import { x } from './sub/x.js';\nexport const open = x;\n`);
    file('db/sub/x.ts', `import { open } from '../open.js';\nexport const x = 1;\nexport const again = open;\n`);
    expect(findFolderCycles(dir)).toEqual([
      {
        folders: ['domain/search', 'domain/sharing'],
        edges: [
          ['domain/search/rank.ts', 'domain/sharing/scope.ts'],
          ['domain/sharing/both.ts', 'domain/search/rank.ts'],
        ],
      },
    ]);
  });

  // Parses every src file (about 0.7 s locally), which a loaded CI runner stretches past the 5 s unit default.
  it('finds no folder cycle in src', { timeout: 15_000 }, () => {
    expect(findFolderCycles(join(import.meta.dirname, '..', '..', 'src'))).toEqual([]);
  });
});
