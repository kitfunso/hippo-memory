// Mirrors rewritten after the job that changed their rows. Each row's meta mark commits with the
// row, so a crash before the rewrite leaves the mark, and the store's next open rewrites that
// mirror.
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  withWriteScope,
} from '../../db/index.js';
import { oncePerStore, type StoreAt } from '../../db/connect.js';
import { grantFor } from './grant.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import { readEntriesByIds } from './entry-reads.js';
import { deferMirrorWrite, mirrorBestEffort, writeMarkdownMirrors } from './mirrors.js';
import { cachedStatement } from '../../db/statement-cache.js';

const DUE = 'mirror_due:';
// The first key past every DUE key, as ';' follows ':'.
const DUE_END = 'mirror_due;';
// Below the batch size at which writeMarkdownMirrors lists a layer folder, so a rewrite never reads
// a whole folder.
const DUE_PAGE = 64;

/** One row's mark: its meta key and the token of the write that set it. */
// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
// meta's key and value are both TEXT NOT NULL.
interface DueMark {
  readonly key: string;
  readonly value: string;
}

/** Marks the rows' mirrors due inside the caller's transaction, under a fresh token, so a
 * rewrite that read an older token leaves the mark for the next one. */
export function markMirrorsDue(db: DatabaseSyncLike, ids: readonly string[]): void {
  if (ids.length === 0) return;
  cachedStatement(
    db,
    `INSERT INTO meta (key, value) SELECT ? || value, ? FROM json_each(?) WHERE true
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(DUE, randomUUID(), JSON.stringify(ids));
}

/** Rewrites the due mirrors once the current job is done, on a connection of its own. */
export function deferDueMirrors(at: StoreAt): void {
  deferMirrorWrite(at, 'markdown mirrors', () => rewriteDueMirrorsIn(at));
}

/** On a store's first open in this runtime, rewrites the mirrors a crash or a failed rewrite
 * left due; `due` is the open probe's answer when it had one, so a store with none due reads
 * nothing more. */
export function recoverDueMirrors(at: StoreAt, db: DatabaseSyncLike, due?: boolean): void {
  oncePerStore(at, 'due-mirrors', () => {
    if (due ?? dueMarks(db, DUE).length > 0) {
      mirrorBestEffort('markdown mirrors', () => rewriteDueMirrorsIn(at));
    }
  });
}

// No session, so the rewrite neither shares the job's handle nor counts as the job's commit.
function rewriteDueMirrorsIn({ hippoRoot, runtime }: StoreAt): void {
  // A store removed before its deferred rewrite has nothing left to mirror.
  if (!fs.existsSync(getHippoDbPath(hippoRoot))) return;
  const db = grantFor({ runtime }).open(hippoRoot);
  try {
    rewriteDueMirrors(db, hippoRoot);
  } finally {
    closeHippoDb(db);
  }
}

/** Rewrites each due mirror from its row as it stands now, a page at a time; a mark is cleared
 * once its file is written or its row is gone, and only if no later write has marked the row
 * again. */
function rewriteDueMirrors(db: DatabaseSyncLike, hippoRoot: string): void {
  for (let marks = dueMarks(db, DUE); marks.length > 0; marks = dueMarks(db, marks.at(-1)!.key)) {
    // A mark names a row by id alone, and one rewrite serves the marks every tenant's jobs left.
    const rows = readEntriesByIds(
      db,
      marks.map((mark) => mark.key.slice(DUE.length)),
      ALL_TENANTS,
    );
    const written = new Set(writeMarkdownMirrors(hippoRoot, [...rows.values()]));
    const served = marks.filter(({ key }) => {
      const id = key.slice(DUE.length);
      return written.has(id) || !rows.has(id);
    });
    if (served.length > 0) clearMarks(db, served);
  }
}

function dueMarks(db: DatabaseSyncLike, after: string): DueMark[] {
  return cachedStatement(
    db,
    `SELECT key, value FROM meta WHERE key > ? AND key < ? ORDER BY key LIMIT ?`,
  ).all(after, DUE_END, DUE_PAGE) as DueMark[];
}

function clearMarks(db: DatabaseSyncLike, marks: readonly DueMark[]): void {
  const tokens = JSON.stringify(Object.fromEntries(marks.map(({ key, value }) => [key, value])));
  withWriteScope(db, 'clear_due_mirrors', () => {
    cachedStatement(
      db,
      `DELETE FROM meta WHERE key IN (SELECT key FROM json_each(?))
       AND value = (SELECT j.value FROM json_each(?) AS j WHERE j.key = meta.key)`,
    ).run(tokens, tokens);
  });
}
