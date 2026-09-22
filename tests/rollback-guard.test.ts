/** Every rollback reached through catch or finally in src/ carries a guard, so a failed
 *  rollback can never replace the error that caused it. Savepoint rollbacks included. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { pushGoalWithDb } from '../src/goals.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('guarded rollback', () => {
  it('surfaces the original error, not the rollback complaint, when a transaction is already discarded', () => {
    const root = mkdtempSync(join(tmpdir(), 'hippo-rollback-guard-'));
    try {
      initStore(root);
      const db = openHippoDb(root);
      try {
        // SAFETY: PRAGMA page_count always returns one row shaped { page_count }; read at runtime, never hardcode.
        const { page_count: pageCount } = db.prepare('PRAGMA page_count').get() as { page_count: number };
        db.exec(`PRAGMA max_page_count = ${pageCount + 2}`);

        let thrown: unknown;
        try {
          pushGoalWithDb(db, { sessionId: 's1', tenantId: 't1', goalName: 'x'.repeat(1_000_000) });
        } catch (err) {
          thrown = err;
        }

        expect(thrown).toBeInstanceOf(Error);
        // SAFETY: the toBeInstanceOf(Error) check above guarantees this cast.
        const message = (thrown as Error).message;
        expect(message).toMatch(/disk is full/);
        expect(message).not.toMatch(/cannot rollback/);
      } finally {
        closeHippoDb(db);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags zero unguarded rollback sites on an error path under src/', () => {
    const flagged = findErrorPathBareRollbacks(join(repoRoot, 'src'));
    expect(flagged).toEqual([]);
  });

  it('flags an unguarded rollback wherever it sits in the block, and flags nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hippo-rollback-shape-'));
    try {
      writeFileSync(join(dir, 'first.ts'), `} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}
`);
      writeFileSync(join(dir, 'after-a-statement.ts'), `} catch (e) {
  log(e);
  db.exec('ROLLBACK'); // trailing comments do not hide a site
  throw e;
}
`);
      writeFileSync(join(dir, 'nested-finally.ts'), `} finally {
  if (!done) {
    this.db.exec('ROLLBACK TO SAVEPOINT sp');
  }
}
`);
      writeFileSync(join(dir, 'guarded.ts'), `} catch (e) {
  try {
    db.exec('ROLLBACK');
  } catch { /* already rolled back */ }
  throw e;
}
`);
      writeFileSync(join(dir, 'promise-catch.ts'), `run().catch(function (err) {
  db.exec('ROLLBACK');
});
`);
      writeFileSync(join(dir, 'happy-path.ts'), `try {
  const n = update();
  if (n === 0) {
    db.exec('ROLLBACK');
    return null;
  }
} catch (e) {
  throw e;
}
`);

      const flagged = findErrorPathBareRollbacks(dir).map((f) => f.slice(dir.length + 1));
      expect(flagged.sort()).toEqual(['after-a-statement.ts:3', 'first.ts:2', 'nested-finally.ts:3']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A savepoint rollback throws for the same reason a plain one does, so both families count.
const BARE_ROLLBACK = /^[\w.]+\.exec\((['"])ROLLBACK(?: TO SAVEPOINT \w+)?\1\);(\s*\/\/.*)?$/;
const ERROR_PATH_OPENER = /^(\}\s*)?(catch\s*(\([^)]*\))?|finally)\s*\{$/;
const GUARD_OPENER = /^(\}\s*)?try\s*\{$/;
const CLIMBABLE_OPENER = /^(\}\s*)?(else\b|if\s*\(|for\s*\(|while\s*\(|switch\s*\(|do\b)/;

function findErrorPathBareRollbacks(srcDir: string): string[] {
  const flagged: string[] = [];
  for (const file of listTsFilesRecursive(srcDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (BARE_ROLLBACK.test(lines[i].trim()) && onErrorPath(lines, i)) {
        flagged.push(`${file}:${i + 1}`);
      }
    }
  }
  return flagged;
}

// Climb the enclosing blocks by brace balance: catch or finally is an error path, try is the guard.
// SHORTCUT: braces inside strings are counted too; swap in a parser if that ever misfires.
function onErrorPath(lines: string[], start: number): boolean {
  let depth = 0;
  for (let p = start - 1; p >= 0; p--) {
    const line = lines[p].trim();
    if (line.endsWith('{') && depth === 0) {
      if (GUARD_OPENER.test(line)) return false;
      if (ERROR_PATH_OPENER.test(line)) return true;
      if (!CLIMBABLE_OPENER.test(line)) return false;
      continue;
    }
    depth += countChar(line, '}') - countChar(line, '{');
  }
  return false;
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function listTsFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      out.push(...listTsFilesRecursive(p));
    } else if (name.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}
