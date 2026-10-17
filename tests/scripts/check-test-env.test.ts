import { describe, expect, it } from 'vitest';
import { earlyUnstubs, envWrites, onceStubs } from '../../scripts/check-test-env.mjs';

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
