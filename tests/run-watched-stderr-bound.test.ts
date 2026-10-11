import { describe, it, expect, vi } from 'vitest';
import { runWatched } from '../src/learn/autolearn.js';

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
});
