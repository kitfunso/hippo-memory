import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { earlyUnstubs, envWrites, misnamedTests, onceStubs, unscrubbedEnvReads } from '../../scripts/check-test-env.mjs';

const lines = (text: string): number[] => envWrites(text).map((hit) => hit.line);

describe('check-test-env', () => {
  it('flags an assignment, an indexed assignment, a compound assignment and a delete', () => {
    const text = [
      "process.env.A = 'x';",
      "process.env[key] = 'y';",
      "process.env.B ??= 'z';",
      'delete process.env.C;',
      'delete process.env[key];',
    ].join('\n');
    expect(lines(text)).toEqual([1, 2, 3, 4, 5]);
  });

  it('flags Object.assign onto process.env and a replaced env object', () => {
    expect(lines("Object.assign(process.env, { A: '1' });\nprocess.env = { ...process.env };")).toEqual([1, 2]);
  });

  it('passes reads, an env object built for a child and vi.stubEnv', () => {
    const text = [
      'const home = process.env.HOME;',
      "const env = { ...process.env, A: '1' };",
      "const child = Object.assign({}, process.env, { B: '2' });",
      "vi.stubEnv('A', '1');",
      "if (process.env.A === 'x') run();",
    ].join('\n');
    expect(envWrites(text)).toEqual([]);
  });
});

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
const SERVER = `await ${'ser' + 've'}({ port: 0 });\n`;

function misnamedIn(files: Record<string, string>): { file: string; has: string; want: string }[] {
  const root = mkdtempSync(join(tmpdir(), 'hippo-test-names-'));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, 'tests', p)), { recursive: true });
      writeFileSync(join(root, 'tests', p), text);
    }
    return misnamedTests(join(root, 'tests'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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
      'token-eval-ab-run.test.ts': CHILD,
    };
    expect(misnamedIn(files)).toEqual([]);
  });

  it('flags a secret-looking env.ts read missing from ENV_SCRUBBED_IN_TESTS', () => {
    const source = [
      "export const ENV_SCRUBBED_IN_TESTS = Object.freeze(['A_API_KEY']);",
      "export const a = text('A_API_KEY');",
      "export const b = text('B_TOKEN');",
      "export const c = trimmedText('HIPPO_TLS_CERT');",
      "export const d = posInt('HIPPO_PORT_MS');",
      "export const e = raw('HIPPO_HOME');",
    ].join(String.fromCharCode(10));
    expect(unscrubbedEnvReads(source)).toEqual(['B_TOKEN', 'HIPPO_TLS_CERT']);
  });

  it('passes the real env.ts', () => {
    expect(unscrubbedEnvReads(readFileSync('src/base/util/env.ts', 'utf8'))).toEqual([]);
  });
});
