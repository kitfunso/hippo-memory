// Promote to the global store, supersede with a successor, and archive raw memories.

import {
  BadRequestError,
  ConflictError,
  memoryNotFoundText,
} from '../../base/errors/api-errors.js';
import type { ConnectorEvent, StoreHome } from '../../base/ports/store.js';
import { StoreNotPortedError } from '../../base/util/store-blocked.js';
import { assertCallerProject, classifyOriginProject } from '../../base/scope/project-identity.js';
import {
  createSuccessor,
  generateId,
  type Layer,
  type MemoryEntry,
} from '../../base/memory/entry.js';
import { detectSecret } from '../../base/util/secret-detect.js';
import { embedMemoryDetached, folderEmbedTarget } from '../../domain/search/embed-memories.js';
import { globalTargetOf } from '../infra.js';
import { withDetached } from '../detached.js';
import { sharedStoreOf, type Context, type ContextWith } from '../types.js';
import {
  assertCopyRight,
  assertWriteRight,
  isPersonalScope,
  isQuarantineScope,
  scopeReaderOf,
} from '../../base/scope/recall-scope.js';
import { isSuperseded } from '../../base/memory/liveness.js';
import { markedTags, reviewerOf, screenWrite, type ReviewGroup } from './write-screen.js';

/** `globalId` names the copy in the global store; on a shared store nothing is copied and it
 * equals `sourceId`. */
export interface PromoteResult {
  ok: true;
  sourceId: string;
  globalId: string;
  /** Set on a shared store only: the row's origin project, null when it has none. */
  originProject?: string | null;
}

/** The caller's project, which a shared store needs to tell whose row it is. */
export interface PromoteOptions {
  readonly project?: { readonly name: string; readonly aliases?: readonly string[] };
}

/** Copies a local memory into the global store; the inner writeEntry emits 'remember' there, and
 * we add a 'promote' audit event so intent stays distinct. The copy keeps the entry's tenantId
 * on the global side. A shared store copies nothing: see promoteInPlace. */
export async function promote(
  ctx: ContextWith<never, 'folderFiles'>,
  id: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult> {
  if (sharedStoreOf(ctx)) return promoteInPlace(ctx, id, opts.project);
  const files = ctx.store.folderFiles;
  if (files === undefined) throw new StoreNotPortedError(ctx.store.kind, 'folderFiles');
  // Another tenant's row and a row out of the caller's reach read alike, so the reply says nothing
  // of either.
  const [entry] = await ctx.store.entriesByIds([id], ctx.tenantId);
  assertCopyRight(scopeReaderOf(ctx.actor), entry, id, memoryNotFoundText(id));
  // A root's reach sets it for a store kept in a folder, so only a context built without a reach
  // lacks it.
  const target = globalTargetOf(ctx);
  if (target === undefined) {
    throw new Error('promote needs ctx.reach.globalTarget, the global store to copy into');
  }
  assertPromotable(id, entry);

  // The 'promote' row commits with the global copy, so no write follows the commit and a busy store
  // fails the whole promote.
  const globalEntry = globalCopyOf(await files.home(), entry);
  await target.store.promotion.writeCopy(globalEntry, {
    actor: ctx.actor.subject,
    sourceId: id,
    auditAs: { tenantId: ctx.tenantId, actor: ctx.actor.subject },
  });
  // A promote may create the global store, which only the write target names before it exists.
  await withDetached(ctx, (detached) =>
    embedMemoryDetached(folderEmbedTarget(target, ctx.infra), globalEntry, detached),
  );
  return { ok: true, sourceId: id, globalId: globalEntry.id };
}

/** The copy of a local memory, with a new `g_` id so it cannot collide. A project store's NULL
 * row gets its folder back. */
function globalCopyOf(local: StoreHome, entry: MemoryEntry): MemoryEntry {
  return {
    ...entry,
    id: generateId('g'),
    source: `promoted:${local.folder}`,
    originProject: entry.originProject ?? local.project.name,
  };
}

async function promoteInPlace(
  ctx: Context,
  id: string,
  project: PromoteOptions['project'],
): Promise<PromoteResult> {
  // A host admin names no project; every other caller must, before any row is read.
  if (!ctx.actor.hostAdmin) {
    if (project === undefined) {
      throw new BadRequestError("a shared store needs the caller's project");
    }
    assertCallerProject(project);
  }
  const [entry] = await ctx.store.entriesByIds([id], ctx.tenantId);
  const ref =
    project === undefined
      ? undefined
      : { name: project.name, legacyName: project.name, aliases: [...(project.aliases ?? [])] };
  const admitted =
    ctx.actor.hostAdmin === true ||
    (entry !== undefined &&
      ref !== undefined &&
      classifyOriginProject(entry.originProject, ref) !== 'cross-project');
  // An unadmitted row fails like a missing one, so the reply says nothing of other projects.
  const row = admitted ? entry : undefined;
  assertCopyRight(scopeReaderOf(ctx.actor), row, id, memoryNotFoundText(id));
  assertPromotable(id, row);
  // A shared store already serves the row to its project, so a copy would only be a duplicate the
  // next dedupe deletes.
  await ctx.store.appendAuditEvents([
    {
      tenantId: ctx.tenantId,
      actor: ctx.actor.subject,
      op: 'promote',
      targetId: id,
      metadata: { sourceId: id },
    },
  ]);
  return { ok: true, sourceId: id, globalId: id, originProject: row.originProject ?? null };
}

function assertPromotable(id: string, entry: MemoryEntry): void {
  // The copy of a superseded row is born superseded and recall drops it.
  if (isSuperseded(entry)) {
    const by = entry.supersededBy;
    throw new ConflictError(
      by === ''
        ? `Refusing to promote ${id}: it is already superseded.`
        : `Refusing to promote ${id}: it is superseded by ${by}; promote that one instead.`,
    );
  }
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

  // Secret producer veto: promote is a producer path to the global store exactly like shareMemory -
  // same hard rule.
  const promoteSecret = detectSecret(entry);
  if (promoteSecret.flagged) {
    throw new BadRequestError(
      `Refusing to promote ${id} to the global store: content matches secret material (${promoteSecret.reason}). ` +
        `Secrets stay in their owning project's store.`,
    );
  }
}

/** Replace an old memory with new content, chaining old.supersededBy = new.id; the store commits
 * both rows and the audit row together. */
export interface SupersedeResult {
  ok: true;
  oldId: string;
  newId: string;
  /** Set when the successor was held for review: the old row is superseded, and the new one waits in the queue. */
  quarantined?: { reason: string };
}
/** What the successor takes instead of the old row's value. Never set from a request body: the
 * CLI fills it from its flags. */
export interface SupersedeOverrides {
  layer?: Layer;
  tags?: string[];
  pinned?: boolean;
}
export async function supersede(
  ctx: Context,
  oldId: string,
  newContent: string,
  overrides: SupersedeOverrides = {},
): Promise<SupersedeResult> {
  return supersedeScreened(ctx, oldId, newContent, overrides);
}

/** The successor runs the same screen as remember: a member's flagged text in a shared scope is held where the
 * store reviews, else tagged. Secret vetting is not done here. */
async function supersedeScreened(
  ctx: ContextWith<never, ReviewGroup>,
  oldId: string,
  newContent: string,
  overrides: SupersedeOverrides,
): Promise<SupersedeResult> {
  const [old] = await ctx.store.entriesByIds([oldId], ctx.tenantId);
  const target = assertSupersedable(ctx, oldId, old ?? null);
  const reviewer = reviewerOf(ctx);
  const verdict = screenWrite(ctx.actor, {
    content: newContent,
    tags: overrides.tags,
    scope: target.scope ?? null,
    untrusted: false,
    holds: reviewer !== undefined,
  });
  const next = createSuccessor(
    target,
    newContent,
    {
      tenantId: ctx.tenantId,
      baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
      layer: overrides.layer,
      tags: markedTags(overrides.tags ?? target.tags, verdict.marks),
      pinned: overrides.pinned,
    },
    ctx.infra.clock(),
  );
  const successor = { ...next, scope: verdict.scope };
  const write = {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    oldId,
    successor,
  };
  if (reviewer && verdict.quarantine) {
    await reviewer.supersedeHeld({ ...write, quarantine: verdict.quarantine });
    return {
      ok: true,
      oldId,
      newId: successor.id,
      quarantined: { reason: verdict.quarantine.reason },
    };
  }
  await ctx.store.entryWrites.supersede(write);
  return { ok: true, oldId, newId: successor.id };
}

/** The tenant-scoped row to supersede; another tenant's id, or a row out of reach, reads as not
 * found. */
function assertSupersedable(ctx: Context, oldId: string, old: MemoryEntry | null): MemoryEntry {
  const row = old ?? undefined;
  assertWriteRight(scopeReaderOf(ctx.actor), row, oldId, `Memory not found: ${oldId}`);
  // The CAS UPDATE closes the race; this check only gives a clearer error in the common
  // single-writer case.
  if (isSuperseded(row)) {
    const by = row.supersededBy;
    throw new ConflictError(
      by === ''
        ? `Memory ${oldId} is already superseded.`
        : `Memory ${oldId} is already superseded by ${by}. Supersede that one instead.`,
    );
  }
  return row;
}

export interface ArchiveRawResult {
  ok: true;
  archivedAt: string;
}

function archiveOf(ctx: Context, id: string, reason: string) {
  return {
    tenantId: ctx.tenantId,
    actor: ctx.actor.subject,
    ...scopeReaderOf(ctx.actor),
    id,
    reason,
  };
}

/** Archive a kind='raw' memory: its metadata moves to raw_archive and the row is deleted. The
 * store writes the one archive_raw audit row, under the caller's subject. */
export async function rawArchive(
  ctx: Context,
  id: string,
  reason: string,
): Promise<ArchiveRawResult> {
  return {
    ok: true,
    archivedAt: await ctx.store.entryWrites.archiveRaw(archiveOf(ctx, id, reason)),
  };
}

/** rawArchive for a connector's delete: the store logs `event` in the archive's own transaction,
 * so a redelivery finds it logged. */
export async function rawArchiveForEvent(
  ctx: ContextWith<'connectorWrites'>,
  id: string,
  reason: string,
  event: ConnectorEvent,
): Promise<ArchiveRawResult> {
  const archivedAt = await ctx.store.connectorWrites.archiveConnectorEntry({
    ...archiveOf(ctx, id, reason),
    event,
  });
  return { ok: true, archivedAt };
}
