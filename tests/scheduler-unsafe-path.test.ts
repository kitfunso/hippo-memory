// The daily-runner path check refuses what would break the quoted command or split a crontab line.
import { describe, it, expect } from 'vitest';
import { hasUnsafeRunnerPathChars } from '../src/cli/scheduler.js';

const SPECIALS: ReadonlyArray<readonly [string, string]> = [
  ['a double quote', '"'],
  ['a backtick', '`'],
  ['a dollar sign', '$'],
  ['a percent sign', '%'],
  ['a newline', '\n'],
  ['a carriage return', '\r'],
];

describe('hasUnsafeRunnerPathChars', () => {
  for (const platform of ['win32', 'linux'] as const) {
    for (const [name, ch] of SPECIALS) {
      it(`refuses ${name} on ${platform}`, () => {
        expect(hasUnsafeRunnerPathChars(`/store/a${ch}b`, platform)).toBe(true);
      });
    }
  }

  it('refuses a backslash on linux and darwin and accepts it on win32', () => {
    expect(hasUnsafeRunnerPathChars('/store/a\\b', 'linux')).toBe(true);
    expect(hasUnsafeRunnerPathChars('/store/a\\b', 'darwin')).toBe(true);
    expect(hasUnsafeRunnerPathChars('C:\\Users\\me\\.hippo', 'win32')).toBe(false);
  });

  it('accepts an ordinary path with spaces', () => {
    expect(hasUnsafeRunnerPathChars('/home/my user/.hippo store', 'linux')).toBe(false);
    expect(hasUnsafeRunnerPathChars('C:\\Users\\my user\\.hippo', 'win32')).toBe(false);
  });
});
