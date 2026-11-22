import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { isObjectLike } from '../../src/base/session/capture-contract.js';

describe('isObjectLike', () => {
  it.each([
    ['a plain object', {}],
    ['an array', []],
    ['a function', () => 1],
    ['a null-prototype object', Object.create(null)],
    ['an object from another realm', runInNewContext('({})')],
  ])('accepts %s', (_name, value) => {
    expect(isObjectLike(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'text'],
    ['a number', 1],
    ['a boolean', true],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
  ])('refuses %s', (_name, value) => {
    expect(isObjectLike(value)).toBe(false);
  });
});
