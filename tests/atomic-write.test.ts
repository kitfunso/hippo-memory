// writeFileAtomic flushes the temp file before the rename and the folder after it (off Windows), and says so when it has to write in place.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendJsonLine, readSealed, writeFileAtomic as writeWhole } from '../scripts/token-eval/atomic-write.mjs';
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

// The harness's own whole-write helpers in scripts/token-eval/atomic-write.mjs: a different module from src/util/atomic-write.ts above.
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-atomic-'));
const busy = (code: string): Error => Object.assign(new Error(`${code}: busy`), { code });

describe('token-eval writeFileAtomic', () => {
  it('writes the whole text, making the folder', () => {
    const out = path.join(tmp(), 'a', 'b', 'out.json');
    writeWhole(out, '{"a":1}\n');
    expect(fs.readFileSync(out, 'utf8')).toBe('{"a":1}\n');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['out.json']);
  });

  it('killed between the temp write and the rename leaves the target as it was, and the next call deletes the temp', () => {
    const out = path.join(tmp(), 'out.json');
    writeWhole(out, 'old');
    const killed = () => { throw new Error('killed'); };
    expect(() => writeWhole(out, 'new', killed)).toThrow('killed');
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.startsWith('out.json.tmp-'))).toHaveLength(1);
    fs.writeFileSync(path.join(path.dirname(out), 'out.json.tmp-424242'), 'half');
    writeWhole(out, 'newer');
    expect(fs.readFileSync(out, 'utf8')).toBe('newer');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['out.json']);
  });

  it('leaves another file\'s temp alone', () => {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'other.json.tmp-1'), 'x');
    writeWhole(path.join(folder, 'out.json'), 'y');
    expect(fs.readdirSync(folder).sort()).toEqual(['other.json.tmp-1', 'out.json']);
  });

  it('retries a busy rename 3 times and then writes', () => {
    const out = path.join(tmp(), 'out.json');
    let calls = 0;
    writeWhole(out, 'done', (from, to) => {
      calls++;
      if (calls <= 3) throw busy('EBUSY');
      fs.renameSync(from, to);
    });
    expect([calls, fs.readFileSync(out, 'utf8')]).toEqual([4, 'done']);
  });

  it('throws the busy error when the rename stays busy, after 4 tries, and never retries another error', () => {
    const out = path.join(tmp(), 'out.json');
    let calls = 0;
    expect(() => writeWhole(out, 'x', () => { calls++; throw busy('EPERM'); })).toThrow(/EPERM/);
    expect(calls).toBe(4);
    calls = 0;
    expect(() => writeWhole(out, 'x', () => { calls++; throw busy('ENOENT'); })).toThrow(/ENOENT/);
    expect(calls).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('token-eval appendJsonLine and readSealed', () => {
  it('appends one line per call and creates the file', () => {
    const log = path.join(tmp(), 'log.jsonl');
    appendJsonLine(log, { a: 1 });
    appendJsonLine(log, { b: 2 });
    expect(fs.readFileSync(log, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('drops a torn last line first, after lines that hold multi-byte characters', () => {
    const log = path.join(tmp(), 'log.jsonl');
    fs.writeFileSync(log, '{"name":"é"}\n{"name":"ü"}\n{"b":');
    appendJsonLine(log, { c: 3 });
    expect(fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).toEqual([{ name: 'é' }, { name: 'ü' }, { c: 3 }]);
  });

  it('reads a sealed file, null when it is absent, and throws the plan\'s line when it does not parse', () => {
    const folder = tmp();
    expect(readSealed(path.join(folder, 'none.json'))).toBeNull();
    writeWhole(path.join(folder, 's.json'), '{"scale":1.2}\n');
    expect(readSealed(path.join(folder, 's.json'))).toEqual({ scale: 1.2 });
    fs.writeFileSync(path.join(folder, 'bad.json'), '{"scale":');
    expect(() => readSealed(path.join(folder, 'bad.json'))).toThrow(`${path.join(folder, 'bad.json')}: sealed file does not parse; the harness never rebuilds it`);
  });
});
