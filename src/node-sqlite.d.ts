declare module 'node:sqlite' {
  export class StatementSync {
    run(...params: unknown[]): { lastInsertRowid?: number | bigint; changes?: number };
    get<T = unknown>(...params: unknown[]): T | undefined;
    all(...params: unknown[]): unknown[];
  }

  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
