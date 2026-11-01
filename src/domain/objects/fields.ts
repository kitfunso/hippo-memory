// Field checks every typed object shares, so each kind refuses the same input in the same words.

import { BadRequestError } from '../../base/errors/api-errors.js';

/** Required text, trimmed: blank is refused, and so is text over `max` once trimmed. The caller
 * stores the trimmed text. */
export function requireText(value: string | undefined, max: number, field: string): string {
  const text = (value ?? '').trim();
  if (text.length === 0) throw new BadRequestError(`${field} must not be blank`);
  return capText(text, max, field);
}

/** Required text that becomes a tag, a heading or a filter value, so it must also fit on
 * one line. */
export function requireLine(value: string | undefined, max: number, field: string): string {
  return oneLine(requireText(value, max, field), field);
}

/** Optional text, kept as written: only its length is checked. */
export function capText<T extends string | undefined>(value: T, max: number, field: string): T {
  if (value !== undefined && value.length > max) {
    throw new BadRequestError(`${field} must be at most ${max} characters`);
  }
  return value;
}

export function oneLine(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new BadRequestError(`${field} must be a single line (no newlines)`);
  }
  return value;
}
