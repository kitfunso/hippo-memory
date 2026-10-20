// One log line for a stored JSON column that will not read, so a reader that degrades to an empty value still leaves a
// trace.
import { type JsonValue, isJsonObject, tryParseJson } from './json.js';
import { log } from './log.js';

/** Where the value lives. The value itself is never logged: it is caller-written text. */
export interface StoredJsonSite {
  table: string;
  id: string | number;
  column: string;
}

/**
 * Warns the first time a table's column is found damaged in this way, then at debug, so a row read on every recall
 * cannot flood stderr. The row id rides in the fields: a key per row would use up the logger's key cap.
 */
export function warnDamagedColumn(site: StoredJsonSite, problem: 'not valid JSON' | 'wrong shape'): void {
  const { table, id, column } = site;
  log.warnThenDebug(
    `damaged-column:${table}:${column}:${problem}`,
    `store: ${table}.${column} is ${problem}; read as empty`,
    { table, id, column },
  );
}

/** The column's parsed JSON, or undefined after the damage warning when its text is not JSON. */
export function parseStoredJson(site: StoredJsonSite, text: string): JsonValue | undefined {
  const parsed = tryParseJson(text);
  if (parsed === undefined) warnDamagedColumn(site, 'not valid JSON');
  return parsed;
}

/** The column's JSON object, or undefined after the damage warning when its text is not JSON or holds another shape. */
export function parseStoredObject(site: StoredJsonSite, text: string): { [key: string]: JsonValue } | undefined {
  const parsed = parseStoredJson(site, text);
  if (parsed === undefined) return undefined;
  if (isJsonObject(parsed)) return parsed;
  warnDamagedColumn(site, 'wrong shape');
  return undefined;
}
