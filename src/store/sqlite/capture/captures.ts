// hippo.db's Captures: the whole batch on one handle, opened with openStore since a write sets up
// the mirror folders.
import { withWriteScope, type DatabaseSyncLike } from '../../../db/index.js';
import { USER_RULE_TAG, type MemoryEntry } from '../../../base/memory/entry.js';
import type { HeldText } from '../../../base/ports/store/types.js';
import {
  duplicateKey,
  heldTextKeys,
  ruleReplaces,
  storedTextKeys,
} from '../../../base/util/same-text.js';
import { CLI_ACTOR } from '../../../base/scope/actor.js';
import { supersedeInTx, writeEntryMirrors } from '../entries/entry-writes.js';
import { stampOriginProject } from '../entries/entry-row.js';
import { gatedWrite } from './gated-write.js';
import { updateStatsOn } from '../entries/index-and-stats.js';
import type { Handles, StoreFiles } from '../runtime/open.js';
import type {
  CaptureDedup,
  CaptureWriteOptions,
  CapturedOutcome,
  Captures,
} from '../../../base/ports/store/capture.js';
import { listTextsHolding } from '../recall/candidates.js';
import { EVERY_SCOPE } from '../runtime/rule-sql.js';
import { openStore } from '../runtime/handles.js';
import { bound, skipEmpty, type Bodies } from '../runtime/bound.js';

/** The rows under `dedup` that may hold an entry's text. */
function heldRows(
  db: DatabaseSyncLike,
  entries: readonly MemoryEntry[],
  dedup: CaptureDedup,
): HeldText[] {
  const texts = entries.map((entry) => entry.content);
  const admit = dedup.everyScope ? EVERY_SCOPE : undefined;
  return listTextsHolding(db, { tenantId: dedup.tenantId, texts, project: dedup.project, admit });
}

/** The names of the project a stamped rule belongs to: the capture's names when its stamp is one,
 * else the stamp alone; none for a shared-store or user-global stamp. */
function ruleProjectNames(rule: MemoryEntry, dedup: CaptureDedup): readonly string[] {
  const origin = rule.originProject;
  if (!origin) return [];
  return dedup.project?.includes(origin) ? dedup.project : [origin];
}

/** The ids of the held copies of the stamped rule's text that the rule replaces. */
function copiesTheRuleReplaces(
  rows: readonly HeldText[],
  rule: MemoryEntry,
  project: readonly string[],
): string[] {
  const key = duplicateKey(rule.content);
  return rows.flatMap(({ id, ...row }) =>
    id !== undefined && ruleReplaces(row, project) && heldTextKeys(row).includes(key) ? [id] : [],
  );
}

/** One outcome per entry, in order, in one transaction that reads the caller's dedup again
 * first, so a text another writer stored since that read is skipped; mirrors and stats follow
 * the commit. */
function writeCapturedEntries(
  db: DatabaseSyncLike,
  files: StoreFiles,
  entries: readonly MemoryEntry[],
  opts: CaptureWriteOptions,
): CapturedOutcome[] {
  const written: MemoryEntry[] = [];
  const actor = opts.actor ?? CLI_ACTOR;
  const outcomes = withWriteScope(db, 'capture_write', () => {
    const rows = heldRows(db, entries, opts.dedup);
    const held = storedTextKeys(rows);
    return entries.map((entry): CapturedOutcome => {
      const stamped = stampOriginProject(files, entry);
      // A stated rule replaces an unpinned capture copy of its own project, which would hide it
      // from the hooks.
      const project = entry.tags.includes(USER_RULE_TAG)
        ? ruleProjectNames(stamped, opts.dedup)
        : null;
      const stops = project ? storedTextKeys(rows.filter((r) => !ruleReplaces(r, project))) : held;
      if (stops.has(duplicateKey(entry.content))) return 'skipped';
      // One rejected entry must not abort the rest of this capture's entries.
      const outcome = gatedWrite(db, files, stamped, { actor: opts.actor });
      if (outcome === 'skipped:rejected') return 'rejected';
      if (outcome !== 'written') return 'skipped';
      if (project) {
        for (const id of copiesTheRuleReplaces(rows, stamped, project)) {
          supersedeInTx(db, { tenantId: stamped.tenantId, id, newId: stamped.id, actor });
        }
      }
      written.push(stamped);
      return 'captured';
    });
  });
  for (const entry of written) writeEntryMirrors(files.hippoRoot, entry);
  if (!opts.lean && written.length > 0) updateStatsOn(db, files, { remembered: written.length });
  return outcomes;
}

const capturedTextsBodies: Bodies<Pick<Captures, 'textsHolding'>> = {
  textsHolding: (db, tenantId, texts, { project, everyScope } = {}) =>
    listTextsHolding(db, { tenantId, texts, project, admit: everyScope ? EVERY_SCOPE : undefined }),
};

export function sqliteCaptures({ on, files }: Handles): Captures {
  const { write } = bound<Pick<Captures, 'write'>>(
    on,
    { write: (db, ...args) => writeCapturedEntries(db, files, ...args) },
    openStore,
  );
  return {
    write: skipEmpty(write, () => []),
    ...bound(on, capturedTextsBodies, openStore),
  };
}
