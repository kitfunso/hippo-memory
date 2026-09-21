/** A6 item 4: guards the nine catch-side bare ROLLBACK sites (see plan.md). */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { pushGoalWithDb } from '../src/goals.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('rollback guard (A6 item 4)', () => {
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

  it('flags zero catch-side bare ROLLBACK sites under src/ (closes the class)', () => {
    const flagged = findCatchSideBareRollbacks(join(repoRoot, 'src'));
    expect(flagged).toEqual([]);
  });
});

// Mirrors scratchpad/catchside.awk: flag only a bare ROLLBACK sitting right after a catch opener.
function findCatchSideBareRollbacks(srcDir: string): string[] {
  const flagged: string[] = [];
  for (const file of listTsFilesRecursive(srcDir)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "db.exec('ROLLBACK');") continue;
      let p = i - 1;
      while (p >= 0 && lines[p].trim() === '') p--;
      if (p >= 0 && /catch\s*(\([^)]*\))?\s*\{\s*$/.test(lines[p].trim())) {
        flagged.push(`${file}:${i + 1}`);
      }
    }
  }
  return flagged;
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
