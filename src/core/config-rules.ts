// Leaf module: how one config.json value is checked and how a bad one is reported, in one wording.
import { isJsonBoolean, isJsonNumber, isJsonObject, isJsonString, type JsonValue } from '../util/json.js';
import { log } from '../util/log.js';

type Guard<T extends JsonValue | undefined> = (value: JsonValue | undefined) => value is T;

/** Reads the value found at `path` of config.json; a bad one warns once and reads as its fallback. */
export type Reader<T> = (raw: JsonValue | undefined, path: string) => T;

/** Reads one named field of a block. */
export type FieldReader = <F>(field: string, reader: Reader<F>) => F;

function reject(path: string, expect: string, got: JsonValue, using: string): void {
  log.warn(`config.json's "${path}" must be ${expect} (got ${JSON.stringify(got)}) - using ${using}.`);
}

/** `absent` is what a missing value reads as, when that differs from the fallback a bad one gets. */
export function check<T extends JsonValue | undefined>(
  expect: string,
  ok: Guard<T>,
  fallback: T,
  absent: T = fallback,
): Reader<T> {
  return (raw, path) => {
    if (raw === undefined) return absent;
    if (ok(raw)) return raw;
    reject(path, expect, raw, fallback === undefined ? 'nothing' : JSON.stringify(fallback));
    return fallback;
  };
}

/** A block of named fields over `fallback`: fields the block does not name pass through as written. */
export function block<T extends object>(expect: string, fallback: T, fields: (read: FieldReader) => T): Reader<T> {
  return (raw, path) => {
    if (raw === undefined) return { ...fallback };
    if (!isJsonObject(raw)) {
      reject(path, expect, raw, 'the defaults');
      return { ...fallback };
    }
    const read: FieldReader = (field, reader) => reader(raw[field], `${path}.${field}`);
    return { ...fallback, ...raw, ...fields(read) };
  };
}

const isNumber: Guard<number> = (value): value is number => isJsonNumber(value) && Number.isFinite(value);
const isCount: Guard<number> = (value): value is number => isNumber(value) && value >= 0;
const isPositive: Guard<number> = (value): value is number => isNumber(value) && value > 0;
const isFraction: Guard<number> = (value): value is number => isNumber(value) && value >= 0 && value <= 1;
const isBasisPoints: Guard<number> = (value): value is number =>
  isJsonNumber(value) && Number.isInteger(value) && value >= 0 && value <= 10000;
const isTextList: Guard<string[]> = (value): value is string[] => Array.isArray(value) && value.every(isJsonString);

function oneOf<T extends string>(...allowed: readonly T[]): Guard<T> {
  return (value): value is T => isJsonString(value) && allowed.some((option) => option === value);
}

function either<A extends JsonValue | undefined, B extends JsonValue | undefined>(
  first: Guard<A>,
  second: Guard<B>,
): Guard<A | B> {
  return (value): value is A | B => first(value) || second(value);
}

export const flag = (fallback: boolean, absent: boolean = fallback): Reader<boolean> =>
  check('true or false', isJsonBoolean, fallback, absent);
export const count = (fallback: number): Reader<number> => check('a number, 0 or more', isCount, fallback);
export const fraction = (fallback: number): Reader<number> => check('a number from 0 to 1', isFraction, fallback);
export const finite = (fallback: number): Reader<number> => check('a finite number', isNumber, fallback);
export const textList = (fallback: string[]): Reader<string[]> => check('a list of strings', isTextList, fallback);
export const basisPoints = (fallback: number): Reader<number> =>
  check('an integer from 0 to 10000', isBasisPoints, fallback);

export function flagOrAuto(fallback: boolean | 'auto'): Reader<boolean | 'auto'> {
  return check('true, false or "auto"', either(isJsonBoolean, oneOf('auto')), fallback);
}

/** A missing value reads as null, which means every one; a malformed one reads as the empty list. */
export function textListOrAll(expect: string): Reader<string[] | null> {
  return check(expect, (value): value is string[] | null => value === null || isTextList(value), [], null);
}

/** `fallback` may be undefined for a setting that has no default. */
export function positive<F extends number | undefined>(fallback: F): Reader<number | F> {
  return check<number | F>('a number above 0', isPositive, fallback);
}

export function text<F extends string | undefined>(fallback: F): Reader<string | F> {
  return check<string | F>('a string', isJsonString, fallback);
}

export function choice<T extends string, F extends T | undefined>(
  fallback: F,
  ...allowed: readonly T[]
): Reader<T | F> {
  return check<T | F>(
    `one of ${allowed.map((option) => JSON.stringify(option)).join(', ')}`,
    oneOf(...allowed),
    fallback,
  );
}
