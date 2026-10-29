import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ftsAnyPhrase, ftsPhrase } from '../../src/store/sqlite/recall/fts-phrase.js';

describe('ftsPhrase', () => {
  it('doubles each inner double quote and wraps the term', () => {
    expect(ftsPhrase('say "hi"')).toBe('"say ""hi"""');
    expect(ftsAnyPhrase(['a', 'b"c'])).toBe('"a" OR "b""c"');
  });

  it('is a MATCH query FTS5 accepts for a term holding a double quote', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE VIRTUAL TABLE t USING fts5(content)');
    db.prepare('INSERT INTO t(content) VALUES (?)').run('he said "hello" twice');
    const rows = db.prepare('SELECT content FROM t WHERE t MATCH ?').all(ftsAnyPhrase(['"hello"', 'zzz']));
    expect(rows).toHaveLength(1);
    db.close();
  });
});
