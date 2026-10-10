// The CLI may not name a memory writer or the store opener; the files that still do are named in the script, each with its reason.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findCliRecallWrites, findCliStoreWrites, namedOnLines, STORE_WRITER_EXCEPTIONS } from '../scripts/check-cli-recall-writes.mjs';

const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'check-cli-recall-writes.mjs');
const SRC = join(import.meta.dirname, '..', 'src');

describe('check-cli-recall-writes: memory writers and the store opener', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cli-store-writes-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function file(name: string, body: string): void {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body, 'utf8');
  }

  it('flags each writer a CLI file names, imports included, and skips comments and other folders', () => {
    file('cli/watch.ts', "import { writeEntry } from '../store/entry-writes.js';\n// deleteEntry in a comment\nwriteEntry(root, entry);\n");
    file('cli/batch.ts', 'batchWriteAndDelete(root, [], []);\ndeleteEntryCore(db, id);\ndeleteEntry(root, id);\n');
    file('api/refine.ts', "import { writeEntry } from '../store/entry-writes.js';\n");
    expect(findCliStoreWrites(dir)).toEqual([
      { file: 'cli/batch.ts', line: 1, name: 'batchWriteAndDelete' },
      { file: 'cli/batch.ts', line: 2, name: 'deleteEntryCore' },
      { file: 'cli/batch.ts', line: 3, name: 'deleteEntry' },
      { file: 'cli/watch.ts', line: 1, name: 'writeEntry' },
      { file: 'cli/watch.ts', line: 3, name: 'writeEntry' },
    ]);
  });

  it('flags the store opener in the CLI entry file too', () => {
    file('cli.ts', "import { openHippoDb } from './db/index.js';\n");
    expect(findCliStoreWrites(dir)).toEqual([{ file: 'cli.ts', line: 1, name: 'openHippoDb' }]);
  });

  it('lets an excepted file keep only the names listed for it', () => {
    file('cli/projects.ts', 'const db = openHippoDb(root);\nwriteEntry(root, entry);\n');
    file('cli/sleep.ts', 'const db = openHippoDb(root);\n');
    expect(findCliStoreWrites(dir)).toEqual([{ file: 'cli/projects.ts', line: 2, name: 'writeEntry' }]);
  });

  it('exits 1 naming the file and line, and 0 once the import is gone', () => {
    const run = (): { status: number | null; stdout: string; stderr: string } => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf-8' });
    file('cli/watch.ts', "import { writeEntry } from '../store/entry-writes.js';\n");
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(`${dir}/cli/watch.ts:1: writeEntry`);
    file('cli/watch.ts', "import { remember } from '../api/index.js';\n");
    const passed = run();
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('only through functions that take the root. OK.');
  });

  it('finds nothing in this repository, and every exception names a file that still needs it', () => {
    expect(findCliStoreWrites(SRC)).toEqual([]);
    expect(findCliRecallWrites(SRC)).toEqual([]);
    for (const [name, allowed] of Object.entries(STORE_WRITER_EXCEPTIONS)) {
      // A file that names none of its allowed writers any more has an exception to delete.
      expect(namedOnLines(readFileSync(join(SRC, name), 'utf8'), allowed), name).not.toEqual([]);
    }
  });
});
