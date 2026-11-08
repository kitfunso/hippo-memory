// No src file but sql-predicates.ts and the frozen migrations spells a `superseded_by` predicate: the
// shapes below over src/**/*.ts, comment lines dropped, fail with file:line.
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '..', '..', 'src');

const SQL_SPELLINGS: readonly RegExp[] = [
  /superseded_by\s+(?:IS|ISNULL|NOTNULL|NOT\s+NULL)\b/g,
  /superseded_by\s*(?:<>|!=|=)\s*''/g,
  /(?:COALESCE|IFNULL|NULLIF)\([^)]*superseded_by/g,
];

function exempt(path: string): boolean {
  return path === 'db/sql-predicates.ts' || path.startsWith('db/migrations/');
}

function isComment(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/** `path:line` of every SQL spelling; comment lines are blanked, so line numbers stay true and a
 * statement the formatter breaks over lines still matches. */
function spellings(): string[] {
  const found: string[] = [];
  for (const name of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    const path = name.split(sep).join('/');
    if (!path.endsWith('.ts') || exempt(path)) continue;
    const text = readFileSync(join(SRC, name), 'utf8')
      .split('\n')
      .map((line) => (isComment(line) ? '' : line))
      .join('\n');
    for (const form of SQL_SPELLINGS) {
      for (const hit of text.matchAll(form)) {
        const line = text.slice(0, hit.index).split('\n').length;
        found.push(`src/${path}:${line}: ${hit[0].replace(/\s+/g, ' ')}`);
      }
    }
  }
  return found.sort();
}

describe('liveness SQL spelling', () => {
  it('lives in src/db/sql-predicates.ts alone, outside the migrations', () => {
    expect(spellings()).toEqual([]);
  });
});
