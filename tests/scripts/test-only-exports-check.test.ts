import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'check-test-only-exports.mjs');
const PKG = JSON.stringify({ exports: { '.': './dist/index.js' } });
const TEST = "import { seam } from '../src/a.js';\nseam();\n";

type Run = { args?: string[]; status: number; output: string[] };
type Row = { name: string; files: Record<string, string>; runs: Run[] };

// A second src user keeps the export check quiet so each row isolates the naming rule.
function seamRow(name: string, seam: string, status: number, output: string[]): Row {
  return {
    name,
    files: {
      'src/a.ts': `export function ${seam}() {}
`,
      'src/b.ts': `import { ${seam} } from './a.js';
${seam}();
`,
    },
    runs: [{ status, output }],
  };
}

function seamRows(): Row[] {
  return [
    seamRow('a _verbThingForTests seam name passes', '_setThingForTests', 0, ['check OK']),
    seamRow('a __setX seam name fails with file:line name', '__setThing', 1, ['src/a.ts:1 __setThing']),
    seamRow('a ForTests name without the underscore fails', 'setThingForTests', 1, ['src/a.ts:1 setThingForTests']),
  ];
}

const rows: Row[] = [
  {
    name: 'a new test-only export fails and is named',
    files: {
      'src/a.ts': 'export function seam() {}\n',
      'tests/a.test.ts': TEST,
    },
    runs: [{ status: 1, output: ['src/a.ts:seam', 'tests/_helpers'] }],
  },
  {
    name: 'an export with a second src user passes',
    files: {
      'src/a.ts': 'export function seam() {}\n',
      'src/b.ts': "import { seam } from './a.js';\nseam();\n",
      'tests/a.test.ts': TEST,
    },
    runs: [{ status: 0, output: ['check OK'] }],
  },
  {
    name: 'a src comment that names an export is not a use',
    files: {
      'src/a.ts': 'export function seam() {}\n',
      'src/b.ts': '// seam is what the tests call\n/* seam */\nexport const other = 1;\n',
      'tests/a.test.ts': TEST,
    },
    runs: [{ status: 1, output: ['src/a.ts:seam'] }],
  },
  {
    name: 'an export in a package entry file passes',
    files: {
      'src/index.ts': 'export const seam = 1;\n',
      'tests/a.test.ts': "import { seam } from '../src/index.js';\nseam;\n",
    },
    runs: [{ status: 0, output: ['check OK'] }],
  },
  {
    name: 'a leftover baseline file exempts nothing',
    files: {
      'src/a.ts': 'export function seam() {}\n',
      'tests/a.test.ts': TEST,
      '.test-only-exports-baseline.json': JSON.stringify({ count: 1, exports: ['src/a.ts:seam'] }),
    },
    runs: [{ status: 1, output: ['src/a.ts:seam'] }],
  },
  ...seamRows(),
];

describe('check-test-only-exports.mjs', () => {
  it.each(rows)('$name', ({ files, runs }) => {
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
