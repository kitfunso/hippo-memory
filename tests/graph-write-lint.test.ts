/**
 * E3.3 criterion-2 CI lint - tests for scripts/check-graph-writes.mjs.
 * Docs: docs/plans/2026-06-01-e3-graph-write-lint.md
 *
 * The lint enforces: graph tables (entities/relations/graph_extraction_queue) may only
 * be written through the sanctioned src/graph.ts. These tests pin the detection +
 * the false-positive exclusions (sanctioned writer, comment lines, name substrings).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Imported from the .mjs lint script; the CLI main is guarded so this import does
// NOT run the check or process.exit.
import { findGraphWriteViolations } from '../scripts/check-graph-writes.mjs';

describe('check-graph-writes lint (E3.3 criterion 2)', () => {
  it('the real src/ tree is clean (only src/graph.ts writes the graph tables, and it is excluded)', () => {
    expect(findGraphWriteViolations('src')).toEqual([]);
  });

  describe('fixture behavior', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'graph-lint-')); });
    afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

    function file(name: string, body: string): void {
      const p = join(dir, name);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body, 'utf8');
    }

    it('flags INSERT INTO / UPDATE of graph tables in a non-sanctioned file', () => {
      file('clean.ts', `export const x = 1;\nconst q = db.prepare('SELECT * FROM entities WHERE id = ?');\n`);
      file('bad-insert.ts', `db.prepare(\`INSERT INTO entities(tenant_id, name) VALUES (?, ?)\`).run(t, n);\n`);
      file('bad-update.ts', `db.prepare('UPDATE relations SET rel_type = ? WHERE id = ?').run(r, id);\n`);
      const v = findGraphWriteViolations(dir);
      const files = v.map((x) => x.file.replace(/\\/g, '/'));
      expect(files.some((f) => f.endsWith('bad-insert.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('bad-update.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('clean.ts'))).toBe(false); // SELECT FROM is not a write
      expect(v.length).toBe(2);
    });

    it('does NOT flag the sanctioned src/graph.ts (exact relative path), but DOES flag subgraph.ts AND a subdir graph.ts', () => {
      file('graph.ts', `db.prepare('INSERT INTO entities(name) VALUES (?)').run(n);\n`);
      file('subgraph.ts', `db.prepare('INSERT INTO relations(rel_type) VALUES (?)').run(r);\n`);
      file('connectors/graph.ts', `db.prepare('INSERT INTO entities(name) VALUES (?)').run(n);\n`); // a DIFFERENT graph.ts, not sanctioned
      const files = findGraphWriteViolations(dir).map((x) => x.file.replace(/\\/g, '/'));
      expect(files.some((f) => f.endsWith('/graph.ts') && !f.includes('connectors'))).toBe(false);
      expect(files.some((f) => f.endsWith('subgraph.ts'))).toBe(true);
      expect(files.some((f) => f.endsWith('connectors/graph.ts'))).toBe(true); // subdir graph.ts IS linted
    });

    it('catches a MULTI-LINE write (verb and table on separate lines) - codex P2', () => {
      file('multiline.ts', `db.prepare(\`\n  INSERT INTO\n  entities(name)\n  VALUES (?)\`).run(n);\n`);
      const v = findGraphWriteViolations(dir);
      expect(v.length).toBe(1);
      expect(v[0].file.replace(/\\/g, '/').endsWith('multiline.ts')).toBe(true);
    });

    it('catches SQLite write variants: INSERT OR IGNORE/REPLACE + quoted/bracketed identifiers - codex retry P2', () => {
      file('or-ignore.ts', `db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)').run(n);\n`);
      file('or-replace.ts', `db.prepare('INSERT OR REPLACE INTO relations(rel_type) VALUES (?)').run(r);\n`);
      file('quoted.ts', `db.prepare('INSERT INTO "entities"(name) VALUES (?)').run(n);\n`);
      file('bracketed.ts', `db.prepare('UPDATE [graph_extraction_queue] SET status = ?').run(s);\n`);
      const files = findGraphWriteViolations(dir).map((x) => x.file.replace(/\\/g, '/'));
      for (const f of ['or-ignore.ts', 'or-replace.ts', 'quoted.ts', 'bracketed.ts']) {
        expect(files.some((x) => x.endsWith(f)), `expected ${f} flagged`).toBe(true);
      }
    });

    it('does NOT flag comments (block /* */ + line //) that merely mention the pattern', () => {
      file('doc.ts', `/*\n * UPDATE graph_extraction_queue is off-limits here\n * only graph.ts may INSERT INTO entities\n */\n// DELETE FROM relations is also only allowed in graph.ts\nexport const y = 2;\n`);
      expect(findGraphWriteViolations(dir)).toEqual([]);
    });

    it('does NOT false-match a table whose name contains a graph-table name (correlations)', () => {
      file('corr.ts', `db.prepare('INSERT INTO correlations(a, b) VALUES (?, ?)').run(a, b);\nconst u = 'UPDATE correlations SET a = ?';\n`);
      expect(findGraphWriteViolations(dir)).toEqual([]);
    });

    it('flags DELETE FROM a graph table (the single-writer rule covers INSERT/UPDATE/DELETE)', () => {
      file('bad-delete.ts', `db.prepare('DELETE FROM entities WHERE id = ?').run(id);\n`);
      const v = findGraphWriteViolations(dir);
      expect(v.length).toBe(1);
      expect(v[0].file.replace(/\\/g, '/').endsWith('bad-delete.ts')).toBe(true);
    });

    it('does NOT flag DDL forms (CREATE TABLE / BEFORE INSERT ON / BEFORE UPDATE ON)', () => {
      file('ddl.ts', [
        `db.exec('CREATE TABLE entities (id INTEGER PRIMARY KEY)');`,
        `db.exec('CREATE TRIGGER t BEFORE INSERT ON entities BEGIN SELECT 1; END');`,
        `db.exec('CREATE TRIGGER u BEFORE UPDATE ON relations BEGIN SELECT 1; END');`,
      ].join('\n') + '\n');
      expect(findGraphWriteViolations(dir)).toEqual([]);
    });
  });
});
