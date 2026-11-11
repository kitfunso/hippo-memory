// writeFileAtomic flushes the temp file before the rename and the folder after it (off Windows), and says so when it has to write in place.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../src/util/atomic-write.js';

const WINDOWS = process.platform === 'win32';
const NEW_TEXT = 'new content';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-atomic-write-')));
  file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, 'old', 'utf8');
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Step =
  | { op: 'flush file'; bytes: number }
  | { op: 'flush folder' }
  | { op: 'rename'; from: string; to: string };

/** Records each flush and rename as it happens, then lets it through. A crash cannot be staged, so the order of the calls is the evidence. */
function recordSteps(): Step[] {
  const steps: Step[] = [];
  const fsync = fs.fsyncSync.bind(fs);
  const rename = fs.renameSync.bind(fs);
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    const stat = fs.fstatSync(fd);
    steps.push(stat.isDirectory() ? { op: 'flush folder' } : { op: 'flush file', bytes: stat.size });
    fsync(fd);
  });
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    steps.push({ op: 'rename', from: String(from), to: String(to) });
    rename(from, to);
  });
  syncBuiltinESMExports();
  return steps;
}

/** The lines hippo logged, without the trailing timestamp field. */
function captureLog(): () => string[] {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return () => stderr.mock.calls.map((call) => String(call[0]).replace(/ ts=\S+.*$/s, ''));
}

describe('writeFileAtomic through the rename path', () => {
  it('flushes the whole temp file before the rename, then the folder where the platform can', () => {
    const steps = recordSteps();
    const logged = captureLog();

    writeFileAtomic(file, NEW_TEXT);

    const expected: Step[] = [
      { op: 'flush file', bytes: Buffer.byteLength(NEW_TEXT) },
      { op: 'rename', from: `${file}.${process.pid}.tmp`, to: file },
    ];
    if (!WINDOWS) expected.push({ op: 'flush folder' });
    expect(steps).toEqual(expected);
    expect(fs.readFileSync(file, 'utf8')).toBe(NEW_TEXT);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
    expect(logged()).toEqual([]);
  });

  it('flushes a file it creates, too', () => {
    const steps = recordSteps();
    const created = path.join(dir, 'nested', 'new.json');

    writeFileAtomic(created, NEW_TEXT);

    expect(steps.slice(0, 2)).toEqual([
      { op: 'flush file', bytes: Buffer.byteLength(NEW_TEXT) },
      { op: 'rename', from: `${created}.${process.pid}.tmp`, to: created },
    ]);
    expect(fs.readFileSync(created, 'utf8')).toBe(NEW_TEXT);
  });

  it('a temp file that cannot be flushed fails the write and leaves the old content and no temp file', () => {
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    });
    syncBuiltinESMExports();

    expect(() => writeFileAtomic(file, NEW_TEXT)).toThrow(/EIO/);

    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it.skipIf(WINDOWS)('a folder that cannot be flushed is a warning, and the new content still lands', () => {
    const fsync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('EINVAL: invalid argument, fsync'), { code: 'EINVAL' });
      fsync(fd);
    });
    syncBuiltinESMExports();
    const logged = captureLog();

    writeFileAtomic(file, NEW_TEXT);

    expect(fs.readFileSync(file, 'utf8')).toBe(NEW_TEXT);
    expect(logged()).toEqual([`[hippo] warn: could not flush the folder ${dir} to disk after replacing a file in it: EINVAL: invalid argument, fsync`]);
  });
});

describe('writeFileAtomic when the platform refuses the rename', () => {
  it('writes in place and logs one warning that names the file and says the write was not atomic', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' });
    });
    syncBuiltinESMExports();
    const logged = captureLog();

    writeFileAtomic(file, NEW_TEXT);

    expect(fs.readFileSync(file, 'utf8')).toBe(NEW_TEXT);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
    expect(logged()).toEqual([
      `[hippo] warn: ${file} could not be replaced by a rename (EXDEV), so it is written in place: not atomic, a crash mid-write can leave it truncated`,
    ]);
  });
});
