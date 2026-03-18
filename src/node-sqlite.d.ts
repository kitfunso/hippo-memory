declare module 'node:sqlite' {
  export class StatementSync {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
