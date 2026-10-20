import { createRequire } from 'module';
import type { SQLOutputValue } from 'node:sqlite';

const require = createRequire(import.meta.url);

/** A row as node:sqlite returns it, before a cast names its columns. */
type SqlRow = Record<string, SQLOutputValue>;

interface StatementSyncLike {
  run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
  get(...params: unknown[]): SqlRow | undefined;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}

export interface DatabaseSyncLike {
  exec(sql: string): void;
  prepare(sql: string): StatementSyncLike;
  close(): void;
  readonly isOpen?: boolean;
  readonly isTransaction?: boolean;
}

// SAFETY: node:sqlite's DatabaseSync constructor genuinely has this shape at runtime (Node's built-in synchronous
// SQLite module); there are no bundled types for it here, so this require + cast is the module's documented boundary.
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
};

export { DatabaseSync };
