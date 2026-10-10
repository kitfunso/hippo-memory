import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { teeStdStreams } from '../src/util/stream-tee.js';

describe('teeStdStreams', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    vi.restoreAllMocks();
  });

  it('mirrors stdout and stderr chunks to the file and forwards them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tee-'));
    const logFile = path.join(dir, 'out.log');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    restore = teeStdStreams(logFile);
    process.stdout.write('to-out\n');
    process.stderr.write(Buffer.from('to-err\n'));
    restore();
    restore = null;
    expect(fs.readFileSync(logFile, 'utf8')).toBe('to-out\nto-err\n');
    expect(outSpy).toHaveBeenCalledWith('to-out\n');
    expect(errSpy).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('warns once when an append fails and keeps forwarding output', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tee-'));
    const logFile = path.join(dir, 'missing-dir', 'out.log');
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errChunks: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
      errChunks.push(String(c));
      return true;
    });
    restore = teeStdStreams(logFile);
    process.stdout.write('one\n');
    process.stdout.write('two\n');
    process.stdout.write('three\n');
    restore();
    restore = null;
    expect(outSpy).toHaveBeenCalledTimes(3);
    expect(errChunks.filter((c) => c.includes('no longer writable'))).toHaveLength(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
