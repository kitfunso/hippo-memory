import { describe, expect, it } from 'vitest';
import { errorMessage } from '../src/util/log.js';

describe('errorMessage', () => {
  it.each([
    ['an Error', new TypeError('boom'), 'boom'],
    ['a thrown string', 'plain text', 'plain text'],
    ['undefined', undefined, 'undefined'],
    ['a plain object', { code: 7 }, '[object Object]'],
  ])('reports %s as its own text', (_label, thrown, expected) => {
    expect(errorMessage(thrown)).toBe(expected);
  });
});
