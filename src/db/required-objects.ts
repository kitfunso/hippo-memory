import { META_TABLE_DDL } from './meta.js';
import { HEALED_INDEXES, HEALED_TABLES } from './continuity-tables.js';
import { FTS_INDEX_DDL } from './fts-index.js';

const CREATED_NAME = /CREATE\s+(?:VIRTUAL\s+|UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi;

/** Names of every table, index and trigger a `CREATE ... IF NOT EXISTS` in `ddl` makes. */
export function createdObjectNames(ddl: string): string[] {
  return [...ddl.matchAll(CREATED_NAME)].map((m) => m[1]);
}

/** Every object runMigrations re-asserts on a stamped store; the open fast path requires all of them. */
export const REQUIRED_SCHEMA_OBJECTS: readonly string[] = Object.freeze([
  ...createdObjectNames(META_TABLE_DDL),
  ...HEALED_TABLES,
  ...HEALED_INDEXES,
  ...FTS_INDEX_DDL.flatMap(createdObjectNames),
]);
