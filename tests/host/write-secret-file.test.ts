import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeSecretFile } from '../../src/host/atomic-write.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-secret-file-')));
  file = path.join(dir, 'server.key');
  fs.writeFileSync(file, 'old');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const tmpOf = (target: string): string => `${target}.${process.pid}.tmp`;

describe('writeSecretFile', () => {
  it('replaces a stale temp file of this process and restricts the new one while it is empty', () => {
    fs.writeFileSync(tmpOf(file), 'stale');
    const sizes: number[] = [];

    writeSecretFile(file, 'secret\n', (tmp) => sizes.push(fs.statSync(tmp).size));

    expect(sizes).toEqual([0]);
    expect(fs.readFileSync(file, 'utf8')).toBe('secret\n');
    expect(fs.readdirSync(dir)).toEqual(['server.key']);
  });

  it('leaves the old file and no temp file when the restrict callback fails', () => {
    const refuse = (): void => {
      throw new Error('icacls refused');
    };

    expect(() => writeSecretFile(file, 'secret\n', refuse)).toThrow('icacls refused');

    expect(fs.readFileSync(file, 'utf8')).toBe('old');
    expect(fs.readdirSync(dir)).toEqual(['server.key']);
  });

  it.runIf(process.platform !== 'win32')('gives the new file mode 600 even when the old one was 644', () => {
    fs.chmodSync(file, 0o644);

    writeSecretFile(file, 'secret\n', () => {});

    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });
});
