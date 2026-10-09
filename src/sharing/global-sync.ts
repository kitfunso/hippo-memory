// Copying the global store's memories down into a local store.

import { BadRequestError } from '../core/api-errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryEntry } from '../core/memory.js';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../core/agent-memory-tools.js';
import { writeEntry } from '../store/entry-writes.js';
import { loadAllEntries } from '../store/entry-reads.js';
import { classifyOriginProject, resolveProjectIdentity } from '../core/project-identity.js';
import { isSharedStore } from '../core/config.js';
import { detectSecret } from '../util/secret-detect.js';
import { RejectedValueError } from '../store/rejection.js';
import { embedAll } from '../store/embeddings/index.js';
import { log } from '../util/log.js';
import { logEmbedAllFailure } from './search-both.js';

/**
 * Copy all global memories into the local store.
 * Skips entries that already exist locally, by ID or by text (promote and share copy under a new ID).
 * Returns the count of newly copied entries.
 */
export function syncGlobalToLocal(
  localRoot: string,
  globalRoot: string,
  opts: { includeCrossProject?: boolean } = {},
): number {
  if (isSharedStore(localRoot)) {
    throw new BadRequestError(`Refusing to sync into ${localRoot}: a shared store takes no copies of a personal global store, whose rows would reach every member.`);
  }
  if (!fs.existsSync(globalRoot)) return 0;

  // Host-wide read. syncGlobalToLocal copies the global union into a
  // tenant-scoped local store; writeEntry on each row carries the tenant if
  // the local-root context provides one.
  const globalEntries = loadAllEntries(globalRoot);
  const textKey = (e: MemoryEntry): string => `${e.tenantId}\n${e.content}`;
  const localEntries = loadAllEntries(localRoot);
  const localIds = new Set(localEntries.map((e) => e.id));
  const localText = new Set(localEntries.map(textKey));

  // Syncing down must not re-import what ambient context
  // excludes - other-project rows are skipped by default and secret rows
  // are never copied. origin_project is preserved on the copy (writeEntry
  // only stamps when the field is missing).
  const currentProject = resolveProjectIdentity(path.dirname(path.resolve(localRoot)));
  let count = 0;
  // A locally rejected value must not come back through sync down: caught per item, printed as one line.
  let rejected = 0;

  for (const entry of globalEntries) {
    // Skip if already present by ID
    if (localIds.has(entry.id)) continue;
    // Only the global store's user pass sets an imported note's row aside, so a copy would outlive the note.
    if (entry.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX)) continue;
    if (localText.has(textKey(entry))) continue;
    if (detectSecret(entry).flagged) continue;
    if (!opts.includeCrossProject && classifyOriginProject(entry.origin_project, currentProject) === 'cross-project') continue;

    if (!writeUnlessRejected(localRoot, entry)) {
      rejected++;
      continue;
    }
    localText.add(textKey(entry));
    count++;
  }

  finishSyncDown(localRoot, count, rejected);

  return count;
}

/** False when the local store rejects the value; any other failure still throws. */
function writeUnlessRejected(localRoot: string, entry: MemoryEntry): boolean {
  try {
    writeEntry(localRoot, entry);
    return true;
  } catch (err) {
    if (err instanceof RejectedValueError) return false;
    throw err;
  }
}

function finishSyncDown(localRoot: string, count: number, rejected: number): void {
  if (rejected > 0) {
    log.warn(`syncGlobalToLocal: skipped ${rejected} rejected value(s) (run \`hippo unreject\` on the local store to allow).`);
  }

  // Batch producer: one embedAll() on the destination rather than an
  // embedMemory() per copied row (same batching invariant as autoShare).
  if (count > 0) {
    void embedAll(localRoot).catch((err) => logEmbedAllFailure('syncGlobalToLocal', err));
  }
}
