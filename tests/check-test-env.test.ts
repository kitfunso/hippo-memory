import { describe, expect, it } from 'vitest';
import { envWrites } from '../scripts/check-test-env.mjs';

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
