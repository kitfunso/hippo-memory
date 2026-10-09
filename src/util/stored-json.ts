// One log line for a stored JSON column that will not read, so a reader that degrades to an empty value still leaves a trace.
import { log } from '../log.js';

/** Where the value lives. The value itself is never logged: it is caller-written text. */
export interface StoredJsonSite {
  table: string;
  id: string | number;
  column: string;
}

/** Warns the first time this row's column is found damaged, then logs at debug, so a row read on every recall cannot flood stderr. */
export function warnDamagedColumn(site: StoredJsonSite, problem: 'not valid JSON' | 'wrong shape'): void {
  const { table, id, column } = site;
  log.warnThenDebug(`damaged-column:${table}:${id}:${column}`, `store: ${table}.${column} is ${problem}; read as empty`, { table, id, column });
}
