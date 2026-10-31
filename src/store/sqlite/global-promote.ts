// Copies a local memory into the global store; the caller embeds the copy.

import { BadRequestError, NotFoundError } from '../../core/api-errors.js';
import { MemoryEntry, generateId } from '../../core/memory.js';
import { isPersonalScope } from '../../core/recall-scope.js';
import { fallbackOrigin, resolveGlobalRootDir } from '../../core/project-identity.js';
import { isSharedStore } from '../../core/config.js';
import { detectSecret } from '../../util/secret-detect.js';
import { initStore } from '../open.js';
import { writePromotedEntry } from '../entry-writes.js';
import { readEntry } from '../entry-reads.js';
import { isQuarantineScope } from '../quarantine.js';
import type { PromoteOptions } from '../port/promotion.js';

function assertPromotable(id: string, entry: MemoryEntry): void {
  // Same quarantine veto as shareMemory; a promoted copy would have no quarantine record to review.
  if (isQuarantineScope(entry.scope)) {
    throw new BadRequestError(
      `Refusing to promote ${id}: it is quarantined pending review. Approve it first via 'hippo quarantine approve ` +
      `${id}'.`,
    );
  }
  if (isPersonalScope(entry.scope ?? null)) {
    throw new BadRequestError(
      `Refusing to promote ${id}: it is a personal memory and stays with its owner on this server.`,
    );
  }

  // Secret producer veto: promote is a producer path to the global store
  // exactly like shareMemory - same hard rule.
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new BadRequestError(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
      `Secrets stay in their owning project's store.`,
    );
  }
}

/** Copies a local memory to the global store and returns the copy, which gets a new `g_` id so it cannot collide. */
export function copyToGlobal(localRoot: string, id: string, opts?: PromoteOptions): MemoryEntry {
  const entry = readEntry(localRoot, id, opts?.tenantId);
  if (!entry) throw new NotFoundError(`Memory not found: ${id}`);

  assertPromotable(id, entry);

  const globalRoot = resolveGlobalRootDir();
  initStore(globalRoot);

  // A project store's NULL row gets its folder back; a shared store's folder is no caller's project, so NULL stays and
  // the label names no path.
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: isSharedStore(localRoot) ? `shared::${new Date().toISOString()}` : `promoted:${localRoot}`,
    origin_project: entry.origin_project ?? fallbackOrigin(localRoot),
  };

  writePromotedEntry(globalRoot, globalEntry, { actor: opts?.actor, sourceId: id, auditAs: opts?.auditAs });
  return globalEntry;
}
