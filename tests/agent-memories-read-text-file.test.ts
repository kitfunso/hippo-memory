// readTextFile hands back a text file's content, or the reason it set aside whatever sits at the path.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTextFile } from '../src/agent-memories/files.js';

const SIZE_CAP = 256 * 1024;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-read-text-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fileWith(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('readTextFile', () => {
  it('returns the text and the modified time of the file it read', () => {
    const file = fileWith('note.md', 'A note.\n');
    expect(readTextFile(file)).toEqual({ ok: true, text: 'A note.\n', mtimeMs: fs.statSync(file).mtimeMs });
  });

  it('reads a file exactly at the size cap and sets aside one byte over it', () => {
    expect(readTextFile(fileWith('full.md', 'x'.repeat(SIZE_CAP)))).toMatchObject({ ok: true });
    const over = fileWith('over.md', 'x'.repeat(SIZE_CAP + 1));
    expect(readTextFile(over)).toEqual({ ok: false, reason: `${over}: over ${SIZE_CAP} bytes` });
  });

  it('sets aside a folder, an empty file and a file holding a NUL byte, each with its reason', () => {
    const empty = fileWith('empty.md', '');
    const binary = fileWith('binary.md', Buffer.from([0x61, 0x00, 0x62]));
    expect(readTextFile(dir)).toEqual({ ok: false, reason: `${dir}: not a file` });
    expect(readTextFile(empty)).toEqual({ ok: false, reason: `${empty}: empty` });
    expect(readTextFile(binary)).toEqual({ ok: false, reason: `${binary}: not text` });
  });

  it('sets aside a missing file with the system error as the reason', () => {
    const gone = path.join(dir, 'gone.md');
    const result = readTextFile(gone);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining(`${gone}: ENOENT`) });
  });

  // Windows has no FIFO a path can name.
  it.skipIf(process.platform === 'win32')('sets aside a FIFO as not a file, without waiting for a writer', () => {
    const fifo = path.join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    expect(readTextFile(fifo)).toEqual({ ok: false, reason: `${fifo}: not a file` });
  }, 2_000);
});
