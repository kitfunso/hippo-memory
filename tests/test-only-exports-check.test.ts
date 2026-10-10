import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-test-only-exports.mjs');
const PKG = JSON.stringify({ exports: { '.': './dist/index.js' } });
const TEST = "import { seam } from '../src/a.js';\nseam();\n";
const baselineOf = (...exports: string[]) => JSON.stringify({ count: exports.length, exports });

type Run = { args?: string[]; status: number; output: string[] };
type Row = { name: string; files: Record<string, string>; runs: Run[]; count?: number };

// A second src user keeps the ratchet quiet so each row isolates the naming rule.
function seamRow(name: string, seam: string, status: number, output: string[]): Row {
  return {
    name,
    files: {
      'src/a.ts': `export function ${seam}() {}
`,
      'src/b.ts': `import { ${seam} } from './a.js';
${seam}();
`,
      '.test-only-exports-baseline.json': baselineOf(),
    },
    runs: [{ status, output }],
  };
}

function seamRows(): Row[] {
  return [
    seamRow('a _verbThingForTests seam name passes', '_setThingForTests', 0, ['ratchet OK']),
    seamRow('a __setX seam name fails with file:line name', '__setThing', 1, ['src/a.ts:1 __setThing']),
    seamRow('a ForTests name without the underscore fails', 'setThingForTests', 1, ['src/a.ts:1 setThingForTests']),
    seamRow('the published __resetSessionRecallHistoryHttp is exempt', '__resetSessionRecallHistoryHttp', 0, ['ratchet OK']),
  ];
}

const rows: Row[] = [
  {
    name: 'a new test-only export fails and is named',
    files: { 'src/a.ts': 'export function seam() {}\n', 'tests/a.test.ts': TEST, '.test-only-exports-baseline.json': baselineOf() },
    runs: [{ status: 1, output: ['src/a.ts:seam', 'tests/_helpers'] }],
  },
  {
    name: 'an export with a second src user passes',
    files: {
      'src/a.ts': 'export function seam() {}\n',
      'src/b.ts': "import { seam } from './a.js';\nseam();\n",
      'tests/a.test.ts': TEST,
      '.test-only-exports-baseline.json': baselineOf(),
    },
    runs: [{ status: 0, output: ['0 exports'] }],
  },
  {
    name: 'an export in a package entry file passes',
    files: { 'src/index.ts': 'export const seam = 1;\n', 'tests/a.test.ts': "import { seam } from '../src/index.js';\nseam;\n", '.test-only-exports-baseline.json': baselineOf() },
    runs: [{ status: 0, output: ['0 exports'] }],
  },
  {
    name: 'a shrunk set passes and --update lowers the count',
    files: { 'src/a.ts': 'export function seam() {}\n', 'tests/a.test.ts': TEST, '.test-only-exports-baseline.json': baselineOf('src/a.ts:seam', 'src/a.ts:gone') },
    runs: [
      { status: 0, output: ['--update', '1 exports'] },
      { args: ['--update'], status: 0, output: ['Wrote'] },
    ],
    count: 1,
  },
  {
    name: '--update refuses a grown set and leaves the baseline alone',
    files: { 'src/a.ts': 'export function seam() {}\n', 'tests/a.test.ts': TEST, '.test-only-exports-baseline.json': baselineOf() },
    runs: [{ args: ['--update'], status: 1, output: ['Refusing to update', 'src/a.ts:seam'] }],
    count: 0,
  },
  ...seamRows(),
];

describe('check-test-only-exports.mjs', () => {
  it.each(rows)('$name', ({ files, runs, count }) => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-tox-'));
    try {
      const all = { 'package.json': PKG, 'src/keep.ts': '', 'tests/keep.test.ts': '', ...files };
      for (const [p, text] of Object.entries(all)) {
        mkdirSync(dirname(join(root, p)), { recursive: true });
        writeFileSync(join(root, p), text);
      }
      for (const { args = [], status, output } of runs) {
        const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' });
        expect(r.status).toBe(status);
        for (const line of output) expect(r.stdout + r.stderr).toContain(line);
      }
      if (count !== undefined) expect(JSON.parse(readFileSync(join(root, '.test-only-exports-baseline.json'), 'utf8')).count).toBe(count);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
