import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import {
  closeHippoDb,
  type DatabaseSyncLike,
  getHippoDbPath,
  withWriteScope,
} from '../../../db/index.js';
import { oncePerStore, type StoreAt } from '../../../db/connect.js';
import { grantFor } from '../runtime/grant.js';
import { ALL_TENANTS } from '../../../base/util/tenant.js';
import { readEntriesByIds } from '../entries/entry-reads.js';
import { deferMirrorWrite, mirrorBestEffort, writeMarkdownMirrors } from './mirrors.js';
import { cachedStatement } from '../../../db/statement-cache.js';

const DUE = 'mirror_due:';
const DUE_END = 'mirror_due;';
const DUE_PAGE = 64;

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
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

function rewriteDueMirrorsIn({ hippoRoot, runtime }: StoreAt): void {
  if (!fs.existsSync(getHippoDbPath(hippoRoot))) return;
  const db = grantFor({ runtime }).open(hippoRoot);
  try {
    rewriteDueMirrors(db, hippoRoot);
  } finally {
    closeHippoDb(db);
  }
}

function rewriteDueMirrors(db: DatabaseSyncLike, hippoRoot: string): void {
  for (let marks = dueMarks(db, DUE); marks.length > 0; marks = dueMarks(db, marks.at(-1)!.key)) {
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
