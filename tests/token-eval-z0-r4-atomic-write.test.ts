// Round 4's whole-write helpers (scripts/token-eval/atomic-write.mjs): a kill leaves the old file or none, and a sealed file is never rebuilt.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { appendJsonLine, readSealed, writeFileAtomic } from '../scripts/token-eval/atomic-write.mjs';

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'z0-atomic-'));
const busy = (code: string): Error => Object.assign(new Error(`${code}: busy`), { code });

describe('writeFileAtomic', () => {
  it('writes the whole text, making the folder', () => {
    const out = path.join(tmp(), 'a', 'b', 'out.json');
    writeFileAtomic(out, '{"a":1}\n');
    expect(fs.readFileSync(out, 'utf8')).toBe('{"a":1}\n');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['out.json']);
  });

  it('killed between the temp write and the rename leaves the target as it was, and the next call deletes the temp', () => {
    const out = path.join(tmp(), 'out.json');
    writeFileAtomic(out, 'old');
    const killed = () => { throw new Error('killed'); };
    expect(() => writeFileAtomic(out, 'new', killed)).toThrow('killed');
    expect(fs.readFileSync(out, 'utf8')).toBe('old');
    expect(fs.readdirSync(path.dirname(out)).filter((n) => n.startsWith('out.json.tmp-'))).toHaveLength(1);
    fs.writeFileSync(path.join(path.dirname(out), 'out.json.tmp-424242'), 'half');
    writeFileAtomic(out, 'newer');
    expect(fs.readFileSync(out, 'utf8')).toBe('newer');
    expect(fs.readdirSync(path.dirname(out))).toEqual(['out.json']);
  });

  it('leaves another file\'s temp alone', () => {
    const folder = tmp();
    fs.writeFileSync(path.join(folder, 'other.json.tmp-1'), 'x');
    writeFileAtomic(path.join(folder, 'out.json'), 'y');
    expect(fs.readdirSync(folder).sort()).toEqual(['other.json.tmp-1', 'out.json']);
  });

  it('retries a busy rename 3 times and then writes', () => {
    const out = path.join(tmp(), 'out.json');
    let calls = 0;
    writeFileAtomic(out, 'done', (from, to) => {
      calls++;
      if (calls <= 3) throw busy('EBUSY');
      fs.renameSync(from, to);
    });
    expect([calls, fs.readFileSync(out, 'utf8')]).toEqual([4, 'done']);
  });

  it('throws the busy error when the rename stays busy, after 4 tries, and never retries another error', () => {
    const out = path.join(tmp(), 'out.json');
    let calls = 0;
    expect(() => writeFileAtomic(out, 'x', () => { calls++; throw busy('EPERM'); })).toThrow(/EPERM/);
    expect(calls).toBe(4);
    calls = 0;
    expect(() => writeFileAtomic(out, 'x', () => { calls++; throw busy('ENOENT'); })).toThrow(/ENOENT/);
    expect(calls).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('appendJsonLine and readSealed', () => {
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
    writeFileAtomic(path.join(folder, 's.json'), '{"scale":1.2}\n');
    expect(readSealed(path.join(folder, 's.json'))).toEqual({ scale: 1.2 });
    fs.writeFileSync(path.join(folder, 'bad.json'), '{"scale":');
    expect(() => readSealed(path.join(folder, 'bad.json'))).toThrow(`${path.join(folder, 'bad.json')}: sealed file does not parse; the harness never rebuilds it`);
  });
});
