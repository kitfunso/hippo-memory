// Copying the global store's memories down into a local store.

import { BadRequestError } from '../core/api-errors.js';
import * as fs from 'fs';
import * as path from 'path';
import { AGENT_MEMORY_SOURCE_PREFIX } from '../core/agent-memory-tools.js';
import { writeEntriesSkippingRejected } from '../store/entry-writes.js';
import { loadEntriesByIds, loadEntryTextKeys } from '../store/entry-reads.js';
import { chunked } from '../util/chunked.js';
import { withRequestStoresSync } from '../db/request-stores.js';
import { classifyOriginProject, resolveProjectIdentity } from '../core/project-identity.js';
import { isSharedStore } from '../core/config.js';
import { detectSecret } from '../util/secret-detect.js';
import { embedAll } from '../store/embeddings/index.js';
import { log } from '../util/log.js';
import { logEmbedAllFailure } from './search-both.js';

/** Copy all global memories into the local store, skipping entries that already exist locally by ID or text (promote and share copy under a new ID).
 *  Returns the count of newly copied entries. */
export function syncGlobalToLocal(
  localRoot: string,
  globalRoot: string,
  opts: { includeCrossProject?: boolean } = {},
): number {
  if (isSharedStore(localRoot)) {
    throw new BadRequestError(`Refusing to sync into ${localRoot}: a shared store takes no copies of a personal global store, whose rows would reach every member.`);
  }
  if (!fs.existsSync(globalRoot)) return 0;

  return withRequestStoresSync(() => copyMissingRows(localRoot, globalRoot, opts.includeCrossProject === true));
}

const textKey = (e: { tenantId: string; content: string }): string => `${e.tenantId}\n${e.content}`;

/** One open per store and one transaction: id, tenant and text decide which rows to read whole, and the copies commit together. */
function copyMissingRows(localRoot: string, globalRoot: string, includeCrossProject: boolean): number {
  // Host-wide read: the global union is copied into a tenant-scoped local store, and each copy keeps its own tenant.
  const localKeys = loadEntryTextKeys(localRoot);
  const localIds = new Set(localKeys.map((k) => k.id));
  const localText = new Set(localKeys.map(textKey));
  // Only the global store's user pass sets an imported note's row aside, so a copy would outlive the note.
  const candidates = loadEntryTextKeys(globalRoot).filter((k) =>
    !localIds.has(k.id) && !k.source.startsWith(AGENT_MEMORY_SOURCE_PREFIX) && !localText.has(textKey(k)));
  if (candidates.length === 0) return 0;
  const byId = new Map(chunked(candidates.map((k) => k.id)).flatMap((ids) => loadEntriesByIds(globalRoot, ids)).map((e) => [e.id, e]));

  // Syncing down must not re-import what ambient context excludes: other-project rows are skipped by default and secret rows never copied.
  // origin_project is preserved on the copy (the write stamps it only when missing).
  const currentProject = resolveProjectIdentity(path.dirname(path.resolve(localRoot)));
  // A locally rejected value must not come back through sync down: skipped per item, printed as one line.
  let rejected = 0;
  const count = writeEntriesSkippingRejected(localRoot, (put) => {
    for (const { id } of candidates) {
      const entry = byId.get(id);
      // A row the global store dropped between the two reads, or a text an earlier copy in this batch already brought down.
      if (!entry || localText.has(textKey(entry))) continue;
      if (detectSecret(entry).flagged) continue;
      if (!includeCrossProject && classifyOriginProject(entry.origin_project, currentProject) === 'cross-project') continue;
      if (put(entry)) localText.add(textKey(entry));
      else rejected++;
    }
  });
  finishSyncDown(localRoot, count, rejected);
  return count;
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
