import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { findRowCasts, selectNames } from '../../scripts/check-row-casts.mjs';

// The check reads property lists and receiver names, so a small lib keeps the compile inside the unit budget.
const MINIMAL_LIB = [
  'interface Array<T> { length: number; [n: number]: T; map<U>(f: (v: T) => U): U[]; join(sep?: string): string }',
  'interface ReadonlyArray<T> { length: number; readonly [n: number]: T; map<U>(f: (v: T) => U): U[]; join(sep?: string): string }',
  'interface Boolean {} interface Function {} interface CallableFunction {} interface NewableFunction {}',
  'interface IArguments {} interface Number {} interface Object {} interface RegExp {}',
  'interface String { split(sep: string): string[] }',
  'interface IterableIterator<T> {} interface Iterable<T> {}',
  'interface Map<K, V> { get(k: K): V | undefined }',
  'declare var Map: { new <K, V>(): Map<K, V> };',
].join('\n');

const SQLITE = [
  'interface StatementSyncLike { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }',
  'interface DatabaseSyncLike { prepare(sql: string): StatementSyncLike }',
  'declare const db: DatabaseSyncLike;',
].join('\n');

describe('check-row-casts', { timeout: 30_000 }, () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'row-casts-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Each cast's line, whether it carries its own note, and why it fails, for one source file compiled on its own. */
  function castsIn(body: string): { line: number; noted: boolean; problem: string | undefined }[] {
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    const file = join(src, 'entry.ts');
    const lib = join(dir, 'lib.d.ts');
    writeFileSync(file, `${SQLITE}\n${body}`, 'utf8');
    writeFileSync(lib, MINIMAL_LIB, 'utf8');
    const program = ts.createProgram([lib, file], { target: ts.ScriptTarget.ES2022, noEmit: true, noLib: true });
    return findRowCasts(program, src).map(({ line, noted, problem }) => ({ line: line - 3, noted, problem }));
  }

  it('passes an inline row whose every key the SELECT names', () => {
    const body = "const r = db.prepare('SELECT id, COUNT(*) AS n FROM t').get() as { id: string; n: number };";
    expect(castsIn(body)).toEqual([{ line: 1, noted: false, problem: undefined }]);
  });

  it('names the keys a SELECT leaves out', () => {
    const body = "const r = db.prepare('SELECT id FROM t').all() as Array<{ id: string; n: number }>;";
    expect(castsIn(body)[0]?.problem).toBe('the SQL does not name n');
  });

  it('holds a named row to one SAFETY note at its declaration', () => {
    const body = [
      '// SAFETY: every read of this row selects COLS.',
      'interface Row { id: string; kind: string; extra?: number }',
      "const COLS = ['id', 'kind'].join(', ');",
      'const a = db.prepare(`SELECT ${COLS} FROM t`).all() as Row[];',
      'interface Bare { id: string }',
      "const b = db.prepare('SELECT id FROM t').get() as Bare | undefined;",
    ].join('\n');
    expect(castsIn(body)).toEqual([
      { line: 4, noted: false, problem: undefined },
      { line: 6, noted: false, problem: 'Bare carries no SAFETY note' },
    ]);
  });

  it('reads builders, `.map` over constant arrays, and a `let` that is only appended to', () => {
    const body = [
      "const SIDE = ['id', 'kind'];",
      "const cols = (alias: string): string => SIDE.map((c) => `${alias}.${c} AS ${alias}_${c}`).join(', ');",
      'function select(where: string): { sql: string } {',
      '  return { sql: `SELECT ${cols("a")} FROM t a WHERE ${where}` };',
      '}',
      "const q = select('x = ?');",
      'const a = db.prepare(q.sql).get() as { a_id: string; a_kind: string };',
      "let sql = 'SELECT id FROM t';",
      "sql += ' WHERE x = ?';",
      'const b = db.prepare(sql).get() as { id: string };',
    ].join('\n');
    expect(castsIn(body).map((c) => c.problem)).toEqual([undefined, undefined]);
  });

  it('proves only the names both arms of a conditional SQL share', () => {
    const body = [
      'declare const ranked: boolean;',
      "const sql = ranked ? 'SELECT id, rank FROM t' : 'SELECT id FROM t';",
      'const a = db.prepare(sql).all() as Array<{ id: string }>;',
      'const b = db.prepare(sql).all() as Array<{ id: string; rank: number }>;',
    ].join('\n');
    expect(castsIn(body).map((c) => c.problem)).toEqual([undefined, 'the SQL does not name rank']);
  });

  it('fails a cast of a non-SQLite read unless it carries its own note', () => {
    const body = [
      'const m = new Map<string, unknown>();',
      "const a = m.get('k') as number;",
      '// SAFETY: the map holds numbers only.',
      "const b = m.get('k') as number;",
    ].join('\n');
    expect(castsIn(body)).toEqual([
      { line: 2, noted: false, problem: 'not a SQLite read' },
      { line: 4, noted: true, problem: 'not a SQLite read' },
    ]);
  });

  it('reads the names a SELECT, RETURNING clause or PRAGMA answers', () => {
    expect(selectNames('SELECT m.id, m.kind AS k, COUNT(*) AS n, (SELECT 1 FROM x) AS s FROM t')).toEqual([
      'id',
      'k',
      'n',
      's',
    ]);
    expect(selectNames('UPDATE t SET a = 1 RETURNING id, a')).toEqual(['id', 'a']);
    expect(selectNames('SELECT t.* FROM t')).toEqual(['*']);
    expect(selectNames('SELECT \0, id FROM t')).toEqual(['id']);
    expect(selectNames('PRAGMA user_version')).toEqual(['user_version']);
    expect(selectNames('DELETE FROM t')).toBeUndefined();
  });
});
