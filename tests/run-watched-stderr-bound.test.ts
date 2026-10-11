import { describe, it, expect, vi } from 'vitest';
import { runWatched, RunWatchedTimeoutError } from '../src/learn/autolearn.js';

describe('runWatched', () => {
  it('returns only the last 64 KiB of stderr while the terminal gets all of it', async () => {
    const written: number[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(Buffer.byteLength(chunk));
      return true;
    });
    try {
      const script = "process.stderr.write('A'.repeat(200000)); process.stderr.write('END')";
      const { exitCode, stderr } = await runWatched(`"${process.execPath}" -e "${script}"`);
      expect(exitCode).toBe(0);
      expect(Buffer.byteLength(stderr)).toBe(64 * 1024);
      expect(stderr.endsWith('END')).toBe(true);
      expect(written.reduce((a, b) => a + b, 0)).toBe(200003);
    } finally {
      spy.mockRestore();
    }
  });

  it('kills a command that passes its deadline and rejects with a typed error', async () => {
    const err = await runWatched(`"${process.execPath}" -e "setTimeout(() => {}, 3000)"`, 300).catch((e: Error) => e);
    expect(err).toBeInstanceOf(RunWatchedTimeoutError);
    expect(err).toMatchObject({ deadlineMs: 300 });
  });
});
