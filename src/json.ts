// Leaf module: the one value space JSON.parse can produce, so boundary guards narrow a shared type.
import * as fs from 'fs';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

/** Windows PowerShell 5.1 saves JSON with a UTF-8 byte order mark that JSON.parse rejects, so one leading mark is dropped. */
export function readJsonFile(file: string): JsonValue {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.codePointAt(0) === 0xfeff ? text.slice(1) : text);
}
