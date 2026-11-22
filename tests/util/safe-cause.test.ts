import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { safeCause } from '../../src/base/util/safe-cause.js';

const hide = (text: string): string => text.replaceAll('SECRET', '[x]');

function links(err: Error): Error[] {
  const out: Error[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) out.push(e);
  return out;
}

describe('safeCause', () => {
  it('keeps the name, the scrubbed message and a string code, and no other field', () => {
    const parser = Object.assign(new Error('bad SECRET chunk'), {
      name: 'HTTPParserError',
      code: 'HPE_INVALID_CHUNK_SIZE',
      data: 'raw bytes SECRET',
      errors: [new Error('SECRET')],
    });
    const copy = safeCause(parser, hide);

    expect(copy).not.toBe(parser);
    expect(copy.name).toBe('HTTPParserError');
    expect(copy.message).toBe('bad [x] chunk');
    expect(Object.assign({}, copy)).toEqual({ name: 'HTTPParserError', code: 'HPE_INVALID_CHUNK_SIZE' });
    expect(inspect(copy, { depth: null })).not.toContain('SECRET');
    expect(inspect(copy, { depth: null })).not.toContain('raw bytes');
  });

  it('copies only a code that is a string', () => {
    expect(Object.keys(safeCause(Object.assign(new Error('a'), { code: 42 }), hide))).toEqual(['name']);
    expect(Object.keys(safeCause(Object.assign(new Error('a'), { code: undefined }), hide))).toEqual(['name']);
  });

  it('gives each copy a stack that is only its name and message', () => {
    const copy = safeCause(new TypeError('terminated SECRET', { cause: new RangeError('inner') }), hide);

    expect(copy.stack).toBe('TypeError: terminated [x]');
    expect(copy.cause).toMatchObject({ stack: 'RangeError: inner' });
    expect(copy.stack).not.toContain(' at ');
  });

  it('stops at five links and at a cycle', () => {
    const deep = Array.from({ length: 8 }, (_, i) => `link ${i}`).reduceRight<Error | undefined>(
      (next, message) => new Error(message, next === undefined ? undefined : { cause: next }),
      undefined,
    );
    const loop = new Error('loop');
    Object.assign(loop, { cause: new Error('two', { cause: loop }) });

    expect(links(safeCause(deep, hide)).map((e) => e.message)).toEqual([
      'link 0',
      'link 1',
      'link 2',
      'link 3',
      'link 4',
    ]);
    expect(links(safeCause(loop, hide)).map((e) => e.message)).toEqual(['loop', 'two']);
  });

  it('leaves no own cause on the last link', () => {
    const last = links(safeCause(new Error('a', { cause: new Error('b') }), hide)).at(-1);

    expect(last).not.toHaveProperty('cause');
  });

  it('makes an Error of a value that is not one', () => {
    const copy = safeCause('plain SECRET text', hide);

    expect(copy).toBeInstanceOf(Error);
    expect(copy.message).toBe('plain [x] text');
    expect(copy.name).toBe('NonError');
  });

  it('scrubs a name and a string code that hold the secret', () => {
    const leaky = Object.assign(new Error('plain'), { name: 'SECRETError', code: 'E_SECRET_CODE' });
    const copy = safeCause(leaky, hide);

    expect(copy.name).toBe('[x]Error');
    expect(Object.assign({}, copy)).toEqual({ name: '[x]Error', code: 'E_[x]_CODE' });
    expect(inspect(copy, { depth: null })).not.toContain('SECRET');
  });

  describe('when a field cannot be read', () => {
    const throwing = (field: string): Error =>
      Object.defineProperty(new Error('kept'), field, {
        get() {
          throw new Error('SECRET getter');
        },
      });

    it.each([
      ['message', { message: 'the message could not be read', name: 'Error' }],
      ['name', { message: 'kept', name: 'UnreadableError' }],
      ['code', { message: 'kept', name: 'Error', code: 'UNREADABLE' }],
    ])('gives a fixed text for a getter that throws on %s', (field, expected) => {
      const copy = safeCause(throwing(field), hide);

      expect(copy).toMatchObject(expected);
      expect(inspect(copy, { depth: null })).not.toContain('SECRET');
    });

    it('gives a fixed cause for a getter that throws on cause', () => {
      const copy = safeCause(throwing('cause'), hide);

      expect(copy.message).toBe('kept');
      expect(copy.cause).toMatchObject({ message: 'the cause could not be read' });
    });

    it('never reads the stack, so a getter on it changes nothing', () => {
      const copy = safeCause(throwing('stack'), hide);

      expect(copy.stack).toBe('Error: kept');
    });

    it('copies a thrown value with a null prototype under a fixed message', () => {
      const bare = Object.assign(Object.create(null), { secret: 'SECRET' });
      const copy = safeCause(bare, hide);

      expect(copy).toBeInstanceOf(Error);
      expect(copy.message).toBe('the message could not be read');
      expect(copy.name).toBe('NonError');
      expect(inspect(copy, { depth: null })).not.toContain('SECRET');
    });
  });
});
