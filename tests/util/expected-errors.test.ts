// Each helper absorbs the one failure it names and throws every other error on, so no catch swallows an unnamed one.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { ignoringCodes, PATH_UNREADABLE, tryDecodeUri } from '../../src/util/expected-errors.js';
import { parseJson, tryParseJson, tryReadJsonFile } from '../../src/util/json.js';
import { tryParseUrl } from '../../src/util/net.js';
import { errorClassFields, errorFields, _resetLogOnceForTests } from '../../src/util/log.js';
import { parseStoredObject } from '../../src/util/stored-json.js';
import { endReply, writeChunk } from '../../src/server/request.js';

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: forced`), { code });

describe('ignoringCodes', () => {
  it('returns undefined for a named code and the value otherwise', () => {
    expect(
      ignoringCodes(['ENOENT'], () => {
        throw errno('ENOENT');
      }),
    ).toBeUndefined();
    expect(ignoringCodes(['ENOENT'], () => 7)).toBe(7);
  });

  it('throws on an error whose code is not named, and on one with no code', () => {
    expect(() =>
      ignoringCodes(['ENOENT'], () => {
        throw errno('EMFILE');
      }),
    ).toThrow('EMFILE');
    expect(() =>
      ignoringCodes(PATH_UNREADABLE, () => {
        throw new TypeError('not a path');
      }),
    ).toThrow(TypeError);
  });
});

describe('the parse helpers', () => {
  it('tryParseJson returns undefined for text that is not JSON and the value for JSON, null included', () => {
    expect(tryParseJson('{"a":')).toBeUndefined();
    expect(tryParseJson('null')).toBeNull();
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('parseJson throws the parser error', () => {
    expect(() => parseJson('{')).toThrow(SyntaxError);
  });

  it('tryDecodeUri returns undefined for a bad percent escape', () => {
    expect(tryDecodeUri('%E0%A4%A')).toBeUndefined();
    expect(tryDecodeUri('a%20b')).toBe('a b');
  });

  it('tryParseUrl returns undefined for text that is no URL', () => {
    expect(tryParseUrl('not a url')).toBeUndefined();
    expect(tryParseUrl('http://localhost:3000/x')?.host).toBe('localhost:3000');
  });
});

describe('tryReadJsonFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'expected-errors-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads JSON, drops one byte order mark, and gives undefined for a missing file, a folder or bad text', () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, '﻿{"a":1}');
    mkdirSync(join(dir, 'folder'));
    writeFileSync(join(dir, 'bad.json'), '{');
    expect(tryReadJsonFile(good)).toEqual({ a: 1 });
    expect(tryReadJsonFile(join(dir, 'missing.json'))).toBeUndefined();
    expect(tryReadJsonFile(join(dir, 'folder'))).toBeUndefined();
    expect(tryReadJsonFile(join(dir, 'bad.json'))).toBeUndefined();
  });
});

describe('errorClassFields', () => {
  it('keeps the class and the errno name and leaves the text and the stack out', () => {
    expect(errorClassFields(errno('ECONNRESET'))).toEqual({ errorClass: 'Error', errno: 'ECONNRESET' });
    expect(errorClassFields(new RangeError('secret text'))).toEqual({ errorClass: 'RangeError' });
    expect(errorClassFields('plain')).toEqual({ errorClass: 'NonError' });
    expect(errorFields(new RangeError('x'))).toHaveProperty('stack');
  });
});

describe('what a failed reply or a damaged column leaves on stderr', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  const logged = (): string[] => stderr.mock.calls.map((call) => String(call[0]));

  beforeEach(() => {
    _resetLogOnceForTests();
    vi.stubEnv('HIPPO_LOG', 'warn');
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const reply = (): ServerResponse => new ServerResponse(new IncomingMessage(new Socket()));

  it('endReply logs a socket that refuses end() with its class, and does not throw', () => {
    const res = reply();
    vi.spyOn(res, 'end').mockImplementation(() => {
      throw errno('ERR_STREAM_DESTROYED');
    });
    expect(() => endReply(res)).not.toThrow();
    expect(logged().join('')).toMatch(/warn: could not end the reply.*errorClass=Error/s);
  });

  it('writeChunk reports false and logs a socket that refuses the write', () => {
    const res = reply();
    vi.spyOn(res, 'write').mockImplementation(() => {
      throw errno('ERR_STREAM_DESTROYED');
    });
    expect(writeChunk(res, 'x')).toBe(false);
    expect(logged().join('')).toContain('could not write to the reply');
  });

  it('parseStoredObject returns the object, or undefined with one warning for bad JSON or another shape', () => {
    const site = { table: 't', id: 1, column: 'c' };
    expect(parseStoredObject(site, '{"a":1}')).toEqual({ a: 1 });
    expect(parseStoredObject(site, '{')).toBeUndefined();
    expect(parseStoredObject({ ...site, id: 2 }, '[1]')).toBeUndefined();
    expect(logged().filter((line) => line.includes('read as empty'))).toHaveLength(2);
  });
});
