export type TomlTable = { readonly [key: string]: TomlValue };
export type TomlValue = string | readonly TomlValue[] | TomlTable | { readonly scalar: string };

export type TomlStatement =
  | {
      readonly kind: 'table' | 'array-table';
      readonly path: readonly string[];
      readonly line: number;
    }
  | {
      readonly kind: 'key';
      readonly path: readonly string[];
      readonly value: TomlValue;
      readonly line: number;
      readonly endLine: number;
    };

export interface TomlRead {
  readonly statements: readonly TomlStatement[];
}

interface Cursor {
  readonly text: string;
  pos: number;
  line: number;
}

type Entry = readonly [readonly string[], TomlValue];

class Scalar {
  readonly scalar: string;

  constructor(scalar: string) {
    this.scalar = scalar;
  }
}

const BOM = '﻿';
const BARE_KEY = /[A-Za-z0-9_-]/;
const SCALAR_STOP = /[,\]}#\r\n]/;
const HEX = /^[0-9A-Fa-f]+$/;
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['b', '\b'],
  ['t', '\t'],
  ['n', '\n'],
  ['f', '\f'],
  ['r', '\r'],
  ['e', '\x1b'],
  ['"', '"'],
  ['\\', '\\'],
]);
const HEX_WIDTHS: ReadonlyMap<string, number> = new Map([
  ['x', 2],
  ['u', 4],
  ['U', 8],
]);
const SCALAR_FORMS: readonly RegExp[] = [
  /^(?:true|false)$/,
  /^[+-]?(?:inf|nan)$/,
  /^[+-]?\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/,
  /^0(?:x[\dA-Fa-f_]+|o[0-7_]+|b[01_]+)$/,
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/,
  /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/,
];

export function isTomlTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Scalar);
}

const peek = (c: Cursor): string => c.text[c.pos] ?? '';
const startsWith = (c: Cursor, token: string): boolean => c.text.startsWith(token, c.pos);
const atLineBreak = (c: Cursor): boolean => peek(c) === '\n' || peek(c) === '\r';

function skipSpaces(c: Cursor): void {
  while (peek(c) === ' ' || peek(c) === '\t') c.pos++;
}

function readNewline(c: Cursor): boolean {
  if (startsWith(c, '\r\n')) c.pos += 2;
  else if (peek(c) === '\n') c.pos += 1;
  else return false;
  c.line++;
  return true;
}

function skipComment(c: Cursor): void {
  if (peek(c) !== '#') return;
  while (c.pos < c.text.length && !atLineBreak(c)) c.pos++;
}

function endOfLine(c: Cursor): boolean {
  skipSpaces(c);
  skipComment(c);
  return c.pos >= c.text.length || readNewline(c);
}

function skipBlanks(c: Cursor): void {
  do {
    skipSpaces(c);
    skipComment(c);
  } while (readNewline(c));
}

function readEscape(c: Cursor): string | null {
  const code = peek(c);
  c.pos++;
  const simple = ESCAPES.get(code);
  if (simple !== undefined) return simple;
  const width = HEX_WIDTHS.get(code);
  if (width === undefined) return null;
  const digits = c.text.slice(c.pos, c.pos + width);
  if (digits.length !== width || !HEX.test(digits)) return null;
  c.pos += width;
  const point = Number.parseInt(digits, 16);
  return point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)
    ? null
    : String.fromCodePoint(point);
}

function readBasic(c: Cursor): string | null {
  c.pos++;
  let out = '';
  for (;;) {
    if (c.pos >= c.text.length || atLineBreak(c)) return null;
    const ch = peek(c);
    c.pos++;
    if (ch === '"') return out;
    const piece = ch === '\\' ? readEscape(c) : ch;
    if (piece === null) return null;
    out += piece;
  }
}

function readLiteral(c: Cursor): string | null {
  const start = ++c.pos;
  while (c.pos < c.text.length && peek(c) !== "'" && !atLineBreak(c)) c.pos++;
  if (peek(c) !== "'") return null;
  c.pos++;
  return c.text.slice(start, c.pos - 1);
}

function readMultilineEscape(c: Cursor): string | null {
  c.pos++;
  const after = c.pos;
  skipSpaces(c);
  if (!readNewline(c)) {
    c.pos = after;
    return readEscape(c);
  }
  do {
    skipSpaces(c);
  } while (readNewline(c));
  return '';
}

function readMultilinePiece(c: Cursor, quote: string): string | null {
  if (quote === '"' && peek(c) === '\\') return readMultilineEscape(c);
  if (readNewline(c)) return '\n';
  return c.text[c.pos++];
}

function quoteRun(c: Cursor, quote: string): number {
  let end = c.pos;
  while (c.text[end] === quote) end++;
  return end - c.pos;
}

function readMultiline(c: Cursor, quote: string): string | null {
  c.pos += 3;
  readNewline(c);
  let out = '';
  while (c.pos < c.text.length) {
    const run = quoteRun(c, quote);
    if (run > 5) return null;
    c.pos += run;
    if (run >= 3) return out + quote.repeat(run - 3);
    out += quote.repeat(run);
    const piece = run === 0 ? readMultilinePiece(c, quote) : '';
    if (piece === null) return null;
    out += piece;
  }
  return null;
}

function readBareKey(c: Cursor): string | null {
  const start = c.pos;
  while (BARE_KEY.test(peek(c))) c.pos++;
  return c.pos > start ? c.text.slice(start, c.pos) : null;
}

function readSimpleKey(c: Cursor): string | null {
  if (peek(c) === '"') return readBasic(c);
  if (peek(c) === "'") return readLiteral(c);
  return readBareKey(c);
}

function readKey(c: Cursor): string[] | null {
  const parts: string[] = [];
  for (;;) {
    skipSpaces(c);
    const part = readSimpleKey(c);
    if (part === null) return null;
    parts.push(part);
    skipSpaces(c);
    if (peek(c) !== '.') return parts;
    c.pos++;
  }
}

function readScalar(c: Cursor): Scalar | null {
  const start = c.pos;
  while (c.pos < c.text.length && !SCALAR_STOP.test(peek(c))) c.pos++;
  const text = c.text.slice(start, c.pos).replace(/[ \t]+$/, '');
  c.pos = start + text.length;
  return SCALAR_FORMS.some((form) => form.test(text)) ? new Scalar(text) : null;
}

function readItems<T>(c: Cursor, close: string, readItem: (c: Cursor) => T | null): T[] | null {
  c.pos++;
  const items: T[] = [];
  for (;;) {
    skipBlanks(c);
    if (peek(c) === close) {
      c.pos++;
      return items;
    }
    const item = readItem(c);
    if (item === null) return null;
    items.push(item);
    skipBlanks(c);
    if (peek(c) === ',') c.pos++;
    else if (peek(c) !== close) return null;
  }
}

function nest(entries: readonly Entry[]): TomlTable | null {
  const leaves = new Map<string, TomlValue>();
  const groups = new Map<string, Entry[]>();
  for (const [[head, ...rest], value] of entries) {
    if (leaves.has(head) || (rest.length === 0 && groups.has(head))) return null;
    if (rest.length === 0) leaves.set(head, value);
    else groups.set(head, [...(groups.get(head) ?? []), [rest, value]]);
  }
  const nested: [string, TomlValue][] = [];
  for (const [key, group] of groups) {
    const inner = nest(group);
    if (inner === null) return null;
    nested.push([key, inner]);
  }
  return Object.fromEntries([...leaves, ...nested]);
}

function readInlineTable(c: Cursor): TomlTable | null {
  const entries = readItems(c, '}', readEntry);
  return entries === null ? null : nest(entries);
}

function readValue(c: Cursor): TomlValue | null {
  if (startsWith(c, '"""')) return readMultiline(c, '"');
  if (startsWith(c, "'''")) return readMultiline(c, "'");
  if (peek(c) === '"') return readBasic(c);
  if (peek(c) === "'") return readLiteral(c);
  if (peek(c) === '[') return readItems(c, ']', readValue);
  if (peek(c) === '{') return readInlineTable(c);
  return readScalar(c);
}

function readEntry(c: Cursor): Entry | null {
  const key = readKey(c);
  if (key === null || peek(c) !== '=') return null;
  c.pos++;
  skipSpaces(c);
  const value = readValue(c);
  return value === null ? null : [key, value];
}

function readHeader(c: Cursor, line: number): TomlStatement | null {
  const kind = startsWith(c, '[[') ? 'array-table' : 'table';
  const close = kind === 'table' ? ']' : ']]';
  c.pos += close.length;
  const path = readKey(c);
  if (path === null || !startsWith(c, close)) return null;
  c.pos += close.length;
  return { kind, path, line };
}

function readKeyLine(c: Cursor, table: readonly string[], line: number): TomlStatement | null {
  const entry = readEntry(c);
  if (entry === null) return null;
  const [key, value] = entry;
  return { kind: 'key', path: [...table, ...key], value, line, endLine: c.line };
}

const restIsBlank = (c: Cursor): boolean =>
  c.pos >= c.text.length || atLineBreak(c) || peek(c) === '#';

function readStatement(c: Cursor, table: readonly string[]): TomlStatement | 'blank' | null {
  skipSpaces(c);
  const line = c.line;
  if (restIsBlank(c)) return endOfLine(c) ? 'blank' : null;
  const statement = peek(c) === '[' ? readHeader(c, line) : readKeyLine(c, table, line);
  return statement !== null && endOfLine(c) ? statement : null;
}

export function readToml(text: string): TomlRead | null {
  const body = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  if (/\r(?!\n)/.test(body)) return null;
  const c: Cursor = { text: body, pos: 0, line: 0 };
  const statements: TomlStatement[] = [];
  let table: readonly string[] = [];
  while (c.pos < body.length) {
    const statement = readStatement(c, table);
    if (statement === null) return null;
    if (statement === 'blank') continue;
    if (statement.kind !== 'key') table = statement.path;
    statements.push(statement);
  }
  return { statements };
}
