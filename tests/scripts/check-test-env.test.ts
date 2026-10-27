import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  earlyUnstubs,
  longTimeouts,
  misnamedTests,
  onceStubs,
  unscrubbedEnvReads,
} from '../../scripts/check-test-env.mjs';
import { ownTimeouts } from '../../scripts/lib/test-classes.mjs';

describe('onceStubs', () => {
  it('flags a stub made once under an afterEach unstub, at module scope, in a describe body or in beforeAll', () => {
    const text = [
      "vi.stubEnv('A', '1');",
      "describe('x', () => {",
      "  beforeAll(() => { vi.stubEnv('B', '1'); });",
      "  vi.stubEnv('C', '1');",
      '  afterEach(() => { vi.unstubAllEnvs(); });',
      '});',
      'afterEach(() => { vi.unstubAllEnvs(); });',
    ].join('\n');
    expect(onceStubs(text).map((hit) => hit.line)).toEqual([1, 3, 4]);
  });

  it('passes beforeEach stubs, a beforeAll stub with afterAll, a sibling afterEach and a helper', () => {
    const text = [
      "describe('a', () => {",
      "  beforeEach(() => { vi.stubEnv('A', '1'); });",
      '  afterEach(() => { vi.unstubAllEnvs(); });',
      '});',
      "describe('b', () => {",
      "  beforeAll(() => { vi.stubEnv('B', '1'); });",
      '  afterAll(() => { vi.unstubAllEnvs(); });',
      '});',
      "function setup() { vi.stubEnv('C', '1'); }",
    ].join('\n');
    expect(onceStubs(text)).toEqual([]);
  });
});

describe('earlyUnstubs', () => {
  it('flags an unstub that runs before a stop in afterEach, afterAll or finally', () => {
    const text = [
      'afterEach(async () => {',
      '  vi.unstubAllEnvs();',
      '  await handle.stop();',
      '});',
      'try { run(); } finally {',
      '  vi.unstubAllEnvs();',
      '  server.close();',
      '}',
    ].join('\n');
    expect(earlyUnstubs(text).map((hit) => hit.line)).toEqual([2, 6]);
  });

  it('passes an unstub that runs last, and one inside a test body', () => {
    const text = [
      'afterEach(async () => {',
      '  await handle.stop();',
      '  vi.unstubAllEnvs();',
      '});',
      "it('x', async () => {",
      '  vi.unstubAllEnvs();',
      '  await run();',
      '});',
    ].join('\n');
    expect(earlyUnstubs(text)).toEqual([]);
  });
});

// Built from pieces so this file's own text starts nothing and it stays a unit test.
const CHILD = `import { spawn } from 'node:${['child', 'process'].join('_')}';\n`;
const SERVER = `await ${['ser', 've'].join('')}({ port: 0 });\n`;

function inTree<T>(files: Record<string, string>, read: (dir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'hippo-test-names-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, 'tests', p)), { recursive: true });
      writeFileSync(join(root, 'tests', p), text);
    }
    return read(join(root, 'tests'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const misnamedIn = (files: Record<string, string>) => inTree(files, misnamedTests);

describe('misnamedTests', () => {
  it('flags a test whose name does not match the child, server or nothing it starts', () => {
    expect(
      misnamedIn({
        'a.test.ts': CHILD,
        'b.process.test.ts': "import { x } from '../../src/x.js';\n",
        'c/d.test.ts': SERVER,
        'e.server.test.ts': CHILD + SERVER,
      }),
    ).toEqual([
      { file: 'tests/a.test.ts', has: 'unit', want: 'process' },
      { file: 'tests/b.process.test.ts', has: 'process', want: 'unit' },
      { file: 'tests/c/d.test.ts', has: 'unit', want: 'server' },
      { file: 'tests/e.server.test.ts', has: 'server', want: 'process' },
    ]);
  });

  it('keeps a unit test with a long timeout in unit, and leaves a slow name that starts nothing alone', () => {
    const files = {
      'long.test.ts': "it('x', () => {\n}, 90_000);\n",
      'named.slow.test.ts': "import { x } from '../../src/x.js';\n",
    };
    expect(misnamedIn(files)).toEqual([]);
  });

  it('follows a _helpers module that starts a child, through a helper that imports it', () => {
    const files = {
      '_helpers/run.ts': CHILD,
      '_helpers/wrap.ts': "export { run } from './run.js';\n",
      'f.test.ts': "import { run } from './_helpers/wrap.js';\n",
    };
    expect(misnamedIn(files)).toEqual([{ file: 'tests/f.test.ts', has: 'unit', want: 'process' }]);
  });

  it('passes matching names, a plain unit test and an eval test the eval config runs', () => {
    const files = {
      'g.process.test.ts': CHILD,
      'g.server.test.ts': SERVER,
      'g.test.ts': "import { x } from '../../src/x.js';\n",
      'eval/token-eval-ab-run.test.ts': CHILD,
    };
    expect(misnamedIn(files)).toEqual([]);
  });

  it('flags a secret-looking env.ts read missing from ENV_SCRUBBED_IN_TESTS', () => {
    const source = [
      "export const a = text('A_API_KEY');",
      "export const b = text('B_TOKEN');",
      "export const c = trimmedText('HIPPO_TLS_CERT');",
      "export const d = posInt('HIPPO_PORT_MS');",
      "export const e = raw('HIPPO_HOME');",
    ].join(String.fromCharCode(10));
    expect(unscrubbedEnvReads(source, ['A_API_KEY'])).toEqual(['B_TOKEN', 'HIPPO_TLS_CERT']);
  });

  it('passes the real env.ts', () => {
    expect(unscrubbedEnvReads(readFileSync('src/base/util/env.ts', 'utf8'))).toEqual([]);
  });
});

const FN = '() => {}';
const at = (source: string) => ownTimeouts(source, 'x.test.ts').map((t) => t.ms);

describe('ownTimeouts', () => {
  it('reads the timeout of every test, suite and hook form, with its modifiers', () => {
    const forms = [
      `it('a', ${FN}, 20_000);`,
      `test('a', ${FN}, { timeout: 20_000 });`,
      `describe('a', { timeout: 20_000 }, ${FN});`,
      `suite('a', ${FN}, 20000);`,
      ...['beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'aroundEach', 'aroundAll'].map(
        (h) => `${h}(${FN}, 20_000);`,
      ),
      `onTestFinished(${FN}, 20_000);`,
      `ctx.onTestFailed(${FN}, 20_000);`,
      `it.each([1])('a', ${FN}, 20_000);`,
      `test.for([1])('a', ${FN}, 20_000);`,
      `it.skipIf(slow)('a', ${FN}, 20_000);`,
      `it.runIf(fast)('a', ${FN}, 20_000);`,
      `it.only('a', ${FN}, 20_000);`,
      `it.skip('a', ${FN}, 20_000);`,
      `it.concurrent.each([1])('a', ${FN}, 20_000);`,
      `describe.sequential('a', ${FN}, 20_000);`,
      `it.fails('a', ${FN}, 20_000);`,
    ];
    for (const form of forms) expect(at(form), form).toEqual([20_000]);
  });

  it('follows an alias of a test function: a renamed import, a const and test.extend', () => {
    const source = [
      "import { it as check } from 'vitest';",
      'const plain = test;',
      'const withDb = test.extend({});',
      `check('a', ${FN}, 20_000);`,
      `plain('a', ${FN}, 21_000);`,
      `withDb('a', ${FN}, 22_000);`,
    ].join('\n');
    expect(ownTimeouts(source, 'x.test.ts')).toEqual([
      { line: 4, ms: 20_000 },
      { line: 5, ms: 21_000 },
      { line: 6, ms: 22_000 },
    ]);
  });

  it('reads vi.setConfig, vi.waitFor and expect.poll', () => {
    expect(at('vi.setConfig({ testTimeout: 20_000, hookTimeout: 21_000 });')).toEqual([20_000, 21_000]);
    expect(at(`await vi.waitFor(${FN}, { timeout: 20_000 });`)).toEqual([20_000]);
    expect(at(`await vi.waitFor(${FN}, 20_000);`)).toEqual([20_000]);
    expect(at(`await expect.poll(${FN}, { timeout: 20_000 }).toBe(1);`)).toEqual([20_000]);
  });

  it('reads the forms a name match misses: a const options object, waitUntil, a namespace, element access, destructuring', () => {
    const forms = [
      `const opts = { timeout: 20_000 };\nit('a', opts, ${FN});`,
      `const opts = { timeout: 20_000 };\nit('a', ${FN}, opts);`,
      `await vi.waitUntil(${FN}, { timeout: 20_000 });`,
      `import * as V from 'vitest';\nV.it('a', ${FN}, 20_000);`,
      `import * as V from 'vitest';\nawait V.vi.waitFor(${FN}, 20_000);`,
      `it['skip']('a', ${FN}, 20_000);`,
      `const { it: check } = await import('vitest');\ncheck('a', ${FN}, 20_000);`,
      `const { skip } = it;\nskip('a', ${FN}, 20_000);`,
    ];
    for (const form of forms) expect(at(form), form).toEqual([20_000]);
  });

  it('reads a quoted timeout key, and gives null for options with a computed key', () => {
    expect(at(`it('a', ${FN}, { 'timeout': 60_000 });`)).toEqual([60_000]);
    expect(at(`vi.setConfig({ "testTimeout": 20_000, 'hookTimeout': 21_000 });`)).toEqual([20_000, 21_000]);
    expect(at(`it('a', ${FN}, { [key]: 60_000 });`)).toEqual([null]);
    expect(at(`vi.setConfig({ [key]: 20_000 });`)).toEqual([null, null]);
  });

  it('gives null for options in second place it cannot read, and for a test call through a computed key', () => {
    expect(at(`it('a', makeOpts(), ${FN});`)).toEqual([null]);
    expect(at(`it[mode]('a', ${FN}, 20_000);`)).toEqual([20_000]);
  });

  it('gives null for a timeout it cannot read: a name or a spread', () => {
    expect(at(`it('a', ${FN}, LONG);`)).toEqual([null]);
    expect(at(`it('a', ${FN}, { ...o });`)).toEqual([null]);
  });

  it('skips calls that are not tests and text that only looks like one', () => {
    const source = [
      `it('a', ${FN}, 10_000);`,
      `const s = "it('a', ${FN}, 20000); setTimeout(${FN}, 20000)";`,
      `setTimeout(${FN}, 20000);`,
      'await fetchWithRetry(url, {}, { timeoutMs: 60_000 });',
      `it('b', ${FN});`,
    ].join('\n');
    expect(at(source)).toEqual([10_000]);
  });
});

describe('longTimeouts', () => {
  it('lists each timeout over 10 s or unreadable, in any test file the eval config does not run', () => {
    const files = {
      'a.test.ts': `it('a', ${FN}, 20_000);\nit('b', ${FN}, 10_000);\n`,
      'b.process.test.ts': `it('a', ${FN}, LONG);\n`,
      'eval/token-eval-other.test.ts': `it('a', ${FN}, 20_000);\n`,
      'eval/token-eval-ab-run.test.ts': `it('a', ${FN}, 600_000);\n`,
      'ok.test.ts': `it('a', ${FN});\n`,
    };
    expect(inTree(files, longTimeouts)).toEqual([
      { file: 'tests/a.test.ts', line: 1, ms: 20_000 },
      { file: 'tests/b.process.test.ts', line: 1, ms: null },
      { file: 'tests/eval/token-eval-other.test.ts', line: 1, ms: 20_000 },
    ]);
  });
});
