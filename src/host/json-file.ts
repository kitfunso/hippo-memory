// Reads a JSON file from disk; src/base/util/json.ts holds the value type and its guards.
import * as fs from 'node:fs';
import { ignoringCodes, PATH_UNREADABLE } from '../base/util/expected-errors.js';
import { parseJson, tryParseJson, type JsonValue } from '../base/util/json.js';

// Windows PowerShell 5.1 saves JSON with a UTF-8 byte order mark that JSON.parse rejects.
const withoutBom = (text: string): string => (text.codePointAt(0) === 0xfeff ? text.slice(1) : text);

/** The file's JSON, with one leading byte order mark dropped. */
export function readJsonFile(file: string): JsonValue {
  return parseJson(withoutBom(fs.readFileSync(file, 'utf8')));
}

/** The file's JSON, or undefined when the path holds nothing readable or the text is not JSON. */
export function tryReadJsonFile(file: string): JsonValue | undefined {
  return ignoringCodes(PATH_UNREADABLE, () => tryParseJson(withoutBom(fs.readFileSync(file, 'utf8'))));
}
