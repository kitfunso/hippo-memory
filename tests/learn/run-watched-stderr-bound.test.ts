import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatched, RunWatchedTimeoutError } from '../../src/surface/cli/run-watched.js';

/** Runs argv under runWatched with stderr captured, so the child's stderr is the result and the terminal stays quiet. */
async function stderrOf(argv: readonly string[]): Promise<{ exitCode: number; stderr: string }> {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    return await runWatched(argv);
  } finally {
    spy.mockRestore();
  }
}

const SHELL_META = ['a;b', 'c&d', '$(echo pwned)', '`id`', '|x', '%PATH%', 'two words'];

describe('runWatched', () => {
  it('returns only the last 64 KiB of stderr while the terminal gets all of it', async () => {
    const written: number[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(Buffer.byteLength(chunk));
      return true;
    });
    try {
      const script = "process.stderr.write('A'.repeat(200000)); process.stderr.write('END')";
      const { exitCode, stderr } = await runWatched([process.execPath, '-e', script]);
      expect(exitCode).toBe(0);
      expect(Buffer.byteLength(stderr)).toBe(64 * 1024);
      expect(stderr.endsWith('END')).toBe(true);
      expect(written.reduce((a, b) => a + b, 0)).toBe(200003);
    } finally {
      spy.mockRestore();
    }
  });

  it('kills a command that passes its deadline and rejects with a typed error', async () => {
    const err = await runWatched([process.execPath, '-e', 'setTimeout(() => {}, 3000)'], 300).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RunWatchedTimeoutError);
    expect(err).toMatchObject({ deadlineMs: 300 });
  });

  it('hands every argument to the program literally, with no shell to read ; & or $()', async () => {
    const { exitCode, stderr } = await stderrOf([
      process.execPath,
      '-e',
      'process.stderr.write(JSON.stringify(process.argv.slice(1)))',
      ...SHELL_META,
    ]);
    expect(exitCode).toBe(0);
    expect(JSON.parse(stderr)).toEqual(SHELL_META);
  });

  it.runIf(process.platform === 'win32')('runs a .cmd shim with the same literal arguments', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-run-watched-'));
    try {
      const echo = join(dir, 'echo-args.js');
      writeFileSync(echo, 'process.stderr.write(JSON.stringify(process.argv.slice(2)))');
      const shim = join(dir, 'shim.cmd');
      writeFileSync(shim, `@"${process.execPath}" "${echo}" %*\r\n`);
      const { exitCode, stderr } = await stderrOf([shim, ...SHELL_META]);
      expect(exitCode).toBe(0);
      expect(JSON.parse(stderr)).toEqual(SHELL_META);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
