// Field checks the typed objects share. The module passes each error text in full, because the wording differs per type.

import { BadRequestError } from '../core/api-errors.js';

export interface LineMessages {
  readonly required: string;
  readonly singleLine: string;
  readonly tooLong: string;
}

/** A one-line name such as a repo or a customer: trimmed first, because the trimmed value is what gets stored and matched. */
export function requireLine(value: string, max: number, m: LineMessages): string {
  const line = (value ?? '').trim();
  if (line.length === 0) throw new BadRequestError(m.required);
  if (/[\r\n]/.test(line)) throw new BadRequestError(m.singleLine);
  if (line.length > max) throw new BadRequestError(m.tooLong);
  return line;
}

export interface TextMessages {
  /** Leave out for an optional field. */
  readonly required?: string;
  readonly tooLong: string;
}

/** A body stored as written: blank fails a required one, and the cap counts the untrimmed length. */
export function checkText(value: string | undefined, max: number, m: TextMessages): void {
  if (m.required !== undefined && (!value || value.trim().length === 0)) throw new BadRequestError(m.required);
  if (value !== undefined && value.length > max) throw new BadRequestError(m.tooLong);
}
