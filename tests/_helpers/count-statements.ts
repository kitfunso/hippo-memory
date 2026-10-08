// Records every SQL statement a real SQLite store executes, so a test can pin how query counts grow with rows.
import { vi } from 'vitest';
import { createRequire } from 'module';

type SqlValue = string | number | bigint | null | Uint8Array;
type SqlParams = Array<SqlValue | Record<string, SqlValue>>;
interface StatementProto { readonly sourceSQL: string }
interface DatabaseProto { exec(sql: string): void }
type StatementCall = (this: StatementProto, ...params: SqlParams) => object | undefined;

const require = createRequire(import.meta.url);
// SAFETY: node:sqlite has no bundled types; each method below takes SQL params and returns a row, rows, an iterator or a run summary.
const { DatabaseSync, StatementSync } = require('node:sqlite') as {
  DatabaseSync: { prototype: DatabaseProto };
  StatementSync: { prototype: Record<'run' | 'get' | 'all' | 'iterate', StatementCall> };
};

/** Every connection open sets its busy timeout first, so this counts store opens. */
export const STORE_OPEN = /^PRAGMA busy_timeout = [1-9]/;

export interface StatementLog<T> {
  result: T;
  statements: string[];
}

/** Runs `fn` and returns the SQL of every exec and every prepared-statement execution, in call order. */
export function recordStatements<T>(fn: () => T): StatementLog<T> {
  const statements: string[] = [];
  const spies = spyOnStatements(statements);
  try {
    return { result: fn(), statements };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** recordStatements for async work, such as a request to an in-process server, until `fn` settles. */
export async function recordStatementsAsync<T>(fn: () => Promise<T>): Promise<StatementLog<T>> {
  const statements: string[] = [];
  const spies = spyOnStatements(statements);
  try {
    return { result: await fn(), statements };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function spyOnStatements(statements: string[]): Array<{ mockRestore(): void }> {
  const exec = DatabaseSync.prototype.exec;
  const spies: Array<{ mockRestore(): void }> = [vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseProto, sql: string) {
    statements.push(sql);
    exec.call(this, sql);
  })];
  for (const method of ['run', 'get', 'all', 'iterate'] as const) {
    const original = StatementSync.prototype[method];
    // SQL is read at call time: once the store closes, a finalized statement's sourceSQL throws.
    spies.push(vi.spyOn(StatementSync.prototype, method).mockImplementation(function (this: StatementProto, ...params: SqlParams) {
      statements.push(this.sourceSQL);
      return original.apply(this, params);
    }));
  }
  return spies;
}

export function countMatching(statements: readonly string[], pattern: RegExp | string): number {
  return statements.filter((sql) => (pattern instanceof RegExp ? pattern.test(sql) : sql.includes(pattern))).length;
}
