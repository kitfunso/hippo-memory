// scripts/affected-tests.mjs on a small repo: each way a change reaches a test, and the eval tests it leaves out.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { affectedTests } from '../../scripts/affected-tests.mjs';

const TREE = {
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
  'src/c.ts': 'export const c = 3;\n',
  'src/types.ts': 'export type T = number;\n',
  'src/runner.ts': "export const ENTRY = new URL('../dist/worker-entry.js', import.meta.url);\n",
  'src/worker-entry.ts': 'export {};\n',
  'bin/hippo.js': "import '../dist/c.js';\n",
  'docs/guide.md': '# Guide\n',
  'scripts/reads-a.mjs': "import { a } from '../src/a.js';\n",
  'tests/_helpers/h.ts': "import { b } from '../../src/b.js';\nexport const h = b;\n",
  'tests/_helpers/child.mjs': "import '../../dist/c.js';\n",
  'tests/through-helper.test.ts': "import { h } from './_helpers/h.js';\n",
  'tests/through-dist.test.ts': "const { a } = await import('../dist/a.js');\n",
  'tests/scripts/through-script.test.ts': "import '../../scripts/reads-a.mjs';\n",
  'tests/starts-child.process.test.ts':
    "spawn(process.execPath, [join(import.meta.dirname, '_helpers', 'child.mjs')]);\n",
  'tests/type-only.test.ts': "import type { T } from '../src/types.js';\n",
  'tests/by-name.test.ts': "import { serve } from 'hippo-memory/server';\n",
  'tests/reads-docs.test.ts': "const guide = readFileSync(join(root, 'docs', 'guide.md'), 'utf8');\n",
  'tests/reads-src.test.ts': "const text = readFileSync(join(root, 'src', 'c.ts'), 'utf8');\n",
  'tests/runs-bin.process.test.ts': "spawnSync(process.execPath, [join(root, 'bin', 'hippo.js')]);\n",
  'tests/unrelated.test.ts': 'export {};\n',
  'tests/runs-worker.server.test.ts': "import { ENTRY } from '../src/runner.js';\n",
  'tests/eval/token-eval-ab-run.test.ts': "import { a } from '../../src/a.js';\n",
} satisfies Readonly<Record<string, string>>;

let repo: string;
beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'affected-tests-'));
  for (const [file, text] of Object.entries(TREE)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

const testsFor = (...changed: string[]): string[] => affectedTests(repo, changed).tests;

describe('affected-tests', () => {
  it('follows imports through helpers and scripts, a helper started by path, and dist as src; not type-only ones', () => {
    expect(testsFor('tests/_helpers/h.ts')).toEqual(['tests/through-helper.test.ts']);
    expect(testsFor('scripts/reads-a.mjs')).toEqual(['tests/scripts/through-script.test.ts']);
    expect(testsFor('tests/_helpers/child.mjs')).toEqual(['tests/starts-child.process.test.ts']);
    expect(testsFor('src/a.ts')).toEqual(
      expect.arrayContaining(['tests/through-dist.test.ts', 'tests/through-helper.test.ts']),
    );
    expect(testsFor('src/types.ts')).not.toContain('tests/type-only.test.ts');
  });

  it('follows a module src starts by path, as new URL(dist path, import.meta.url) names it', () => {
    expect(testsFor('src/worker-entry.ts')).toContain('tests/runs-worker.server.test.ts');
    expect(testsFor('src/worker-entry.ts')).not.toContain('tests/unrelated.test.ts');
  });

  it('picks a test that imports the package by name when src changed, and only then', () => {
    expect(testsFor('src/c.ts')).toContain('tests/by-name.test.ts');
    expect(testsFor('docs/guide.md')).not.toContain('tests/by-name.test.ts');
  });

  it('picks a test that names a dist, docs or src path as text when that folder changed', () => {
    expect(testsFor('docs/guide.md')).toEqual(['tests/reads-docs.test.ts']);
    const forSrc = testsFor('src/types.ts');
    expect(forSrc).toEqual(expect.arrayContaining(['tests/reads-src.test.ts', 'tests/runs-bin.process.test.ts']));
    expect(forSrc).not.toContain('tests/reads-docs.test.ts');
    expect(testsFor('bin/hippo.js')).toEqual(['tests/runs-bin.process.test.ts']);
  });

  it('picks a changed test, and not one that is gone', () => {
    expect(testsFor('tests/unrelated.test.ts', 'tests/deleted.test.ts')).toEqual(['tests/unrelated.test.ts']);
  });

  it('leaves out the eval tests and names them', () => {
    const { tests, excluded } = affectedTests(repo, ['src/a.ts']);
    expect(excluded).toEqual(['tests/eval/token-eval-ab-run.test.ts']);
    expect(tests).not.toContain('tests/eval/token-eval-ab-run.test.ts');
  });
});
