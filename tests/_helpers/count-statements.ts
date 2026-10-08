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
  /** Rows the statements handed to JavaScript, the work a caller then hydrates and scores. */
  rowsRead: number;
}

/** Runs `fn` and returns the SQL of every exec and every prepared-statement execution, in call order. */
export function recordStatements<T>(fn: () => T): StatementLog<T> {
  const statements: string[] = [];
  const tally = { rows: 0 };
  const spies = spyOnStatements(statements, tally);
  try {
    return { result: fn(), statements, rowsRead: tally.rows };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/** recordStatements for async work, such as a request to an in-process server, until `fn` settles. */
export async function recordStatementsAsync<T>(fn: () => Promise<T>): Promise<StatementLog<T>> {
  const statements: string[] = [];
  const tally = { rows: 0 };
  const spies = spyOnStatements(statements, tally);
  try {
    return { result: await fn(), statements, rowsRead: tally.rows };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

function* countEach(rows: Iterable<object>, tally: { rows: number }): Generator<object> {
  for (const row of rows) {
    tally.rows += 1;
    yield row;
  }
}

function spyOnStatements(statements: string[], tally: { rows: number }): Array<{ mockRestore(): void }> {
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
      const out = original.apply(this, params);
      if (method === 'run' || out === undefined) return out;
      if (method === 'get') tally.rows += 1;
      if (Array.isArray(out)) tally.rows += out.length;
      // SAFETY: iterate() returns an iterator of row objects, counted as the caller pulls them.
      return method === 'iterate' ? countEach(out as Iterable<object>, tally) : out;
    }));
  }
  return spies;
}

export function countMatching(statements: readonly string[], pattern: RegExp | string): number {
  return statements.filter((sql) => (pattern instanceof RegExp ? pattern.test(sql) : sql.includes(pattern))).length;
}
