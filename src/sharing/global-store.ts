// The global store: where it lives, creating it, and copying a local memory into it.

import { BadRequestError, NotFoundError } from '../core/api-errors.js';
import * as fs from 'fs';
import { MemoryEntry, generateId } from '../core/memory.js';
import { initStore } from '../store/open.js';
import { writeEntry } from '../store/entry-writes.js';
import { readEntry } from '../store/entry-reads.js';
import { isPersonalScope } from '../store/recall-scope.js';
import { fallbackOrigin, resolveGlobalRootDir } from '../core/project-identity.js';
import { isSharedStore } from '../core/config.js';
import { detectSecret } from '../util/secret-detect.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import { embedMemory } from '../store/embeddings/index.js';
import type { DatabaseSyncLike } from '../db/index.js';
import { appendAuditEvent } from '../store/audit.js';

/** Returns the path to the global Hippo store.
 *  Resolution order: $HIPPO_HOME > $XDG_DATA_HOME/hippo > ~/.hippo/ */
export function getGlobalRoot(): string {
  // Single source of truth lives in project-identity.ts (leaf) so db migrations
  // can resolve the same path without a shared.ts import cycle.
  return resolveGlobalRootDir();
}

/** Ensure the global store exists. */
export function initGlobal(): void {
  const globalRoot = getGlobalRoot();
  if (!fs.existsSync(globalRoot)) {
    initStore(globalRoot);
  } else {
    // Ensure subdirectories exist in case partially initialized
    initStore(globalRoot);
  }
}

type PromoteHook = (db: DatabaseSyncLike, globalId: string) => void;

/** The copy's write hook: the `promote` row when asked for, then the caller's own hook, both in the copy's transaction. */
function promoteHook(sourceId: string, auditAs: { tenantId: string; actor: string } | undefined, afterWrite: PromoteHook | undefined): PromoteHook | undefined {
  if (!auditAs) return afterWrite;
  return (db, globalId) => {
    appendAuditEvent(db, { tenantId: auditAs.tenantId, actor: auditAs.actor, op: 'promote', targetId: globalId, metadata: { sourceId } });
    afterWrite?.(db, globalId);
  };
}

/** Copies a local memory to the global store and returns the copy, which gets a new `g_` id so it cannot collide. */
export function promoteToGlobal(
  localRoot: string,
  id: string,
  opts?: {
    actor?: string;
    tenantId?: string;
    afterWrite?: (db: DatabaseSyncLike, globalId: string) => void;
    /** Also writes one `promote` audit row for the copy ({sourceId}), in the copy's own transaction. */
    auditAs?: { tenantId: string; actor: string };
  },
): MemoryEntry {
  const entry = readEntry(localRoot, id, opts?.tenantId);
  if (!entry) throw new NotFoundError(`Memory not found: ${id}`);

  // Same quarantine veto as shareMemory; a promoted copy would have no quarantine record to review.
  if (isQuarantineScope(entry.scope)) {
    throw new BadRequestError(`Refusing to promote ${id}: it is quarantined pending review. Approve it first via 'hippo quarantine approve ${id}'.`);
  }
  if (isPersonalScope(entry.scope ?? null)) {
    throw new BadRequestError(`Refusing to promote ${id}: it is a personal memory and stays with its owner on this server.`);
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

  initGlobal();
  const globalRoot = getGlobalRoot();

  // A project store's NULL row gets its folder back; a shared store's folder is no caller's project, so NULL stays and the label names no path.
  const globalEntry: MemoryEntry = {
    ...entry,
    id: generateId('g'),
    source: isSharedStore(localRoot) ? `shared::${new Date().toISOString()}` : `promoted:${localRoot}`,
    origin_project: entry.origin_project ?? fallbackOrigin(localRoot),
  };

  writeEntry(globalRoot, globalEntry, { actor: opts?.actor, afterWrite: promoteHook(id, opts?.auditAs, opts?.afterWrite) });

  // Fire-and-forget: embedMemory gates on availability and never rejects.
  void embedMemory(globalRoot, globalEntry);

  return globalEntry;
}
