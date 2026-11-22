// Quarantine review: list, approve, edit and reject held memories.

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import type { QuarantineRefusal } from '../../base/ports/store.js';
import { StoreNotPortedError } from '../../base/util/store-blocked.js';
import { vetSecrets } from '../../base/util/secret-detect.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { detectInstructionIn } from '../instruction-detect.js';
import type { ContextWith } from '../types.js';
import type { QuarantineEditOutcome, QuarantineStatus } from '../../base/ports/store/quarantine.js';

export interface QuarantineListItem {
  id: string;
  originalScope: string | null;
  reason: string;
  status: QuarantineStatus;
  quarantinedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  contentPreview: string;
  /** The held memory's lead-in, cut like the content; absent when it has none. */
  leadInPreview?: string;
}

const QUARANTINE_PREVIEW_CHARS = 200;

/** A tenant's quarantined memories, newest first. Default `status` is 'pending' (the review
 * queue). */
export async function quarantineList(
  ctx: ContextWith<'quarantine'>,
  opts: { status?: QuarantineStatus | 'all'; limit?: number; after?: KeysetPosition } = {},
): Promise<QuarantineListItem[]> {
  const rows = await ctx.store.quarantine.listQuarantined(ctx.tenantId, {
    status: opts.status ?? 'pending',
    limit: opts.limit,
    after: opts.after,
  });
  return rows.map((row) => {
    const item: QuarantineListItem = {
      id: row.memoryId,
      originalScope: row.originalScope,
      reason: row.reason,
      status: row.status,
      quarantinedAt: row.quarantinedAt,
      decidedAt: row.decidedAt,
      decidedBy: row.decidedBy,
      contentPreview: (row.content ?? '').slice(0, QUARANTINE_PREVIEW_CHARS),
    };
    if (row.leadIn) item.leadInPreview = row.leadIn.slice(0, QUARANTINE_PREVIEW_CHARS);
    return item;
  });
}

function refusalError(id: string, refusal: QuarantineRefusal): Error {
  if (refusal.outcome === 'not_quarantined') return new NotFoundError(`not quarantined: ${id}`);
  return new ConflictError(`${id} is already ${refusal.status}`);
}

/** Release a quarantined memory to its original scope. Admin only; the scope guard refuses a row
 * moved since (mirrors dormantRestore). */
export async function quarantineApprove(ctx: ContextWith<'quarantine'>, id: string): Promise<void> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can approve a quarantined memory');
  }
  const result = await ctx.store.quarantine.decideQuarantined(
    ctx.tenantId,
    id,
    'approve',
    ctx.actor.subject,
  );
  if (result.outcome === 'approved') return;
  if (result.outcome === 'scope_moved') {
    throw new ConflictError(`memory ${id} scope changed since quarantine; refusing to approve`);
  }
  throw refusalError(id, result);
}

/** Keep a quarantined memory hidden for good. Admin only; the raw row is untouched
 * (append-only). */
export async function quarantineReject(ctx: ContextWith<'quarantine'>, id: string): Promise<void> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can reject a quarantined memory');
  }
  const result = await ctx.store.quarantine.decideQuarantined(
    ctx.tenantId,
    id,
    'reject',
    ctx.actor.subject,
  );
  if (result.outcome !== 'rejected') throw refusalError(id, result);
}

type EditRefusal = Exclude<QuarantineEditOutcome, { outcome: 'edited' }>;

function editRefusalError(id: string, refusal: EditRefusal): Error {
  switch (refusal.outcome) {
    case 'deleted':
      return new NotFoundError(`memory ${id} was deleted after it was held; nothing was changed`);
    case 'superseded':
      return new ConflictError(
        `memory ${id} was already replaced by ${refusal.supersededBy}; nothing was changed`,
      );
    case 'scope_moved':
      return new ConflictError(`memory ${id} scope changed since quarantine; refusing to edit`);
    default:
      return refusalError(id, refusal);
  }
}

export interface QuarantineEditResult {
  edited: string;
  newId: string;
  /** The held memory's lead-in, which the edit keeps; absent when it has none. */
  keptLeadIn?: string;
  warnings?: string[];
}

/** Release a quarantined memory with the admin's text in place of the held text. Admin only; the
 * text runs the write screen again, and the held row stays as delivered. */
export async function quarantineEdit(
  ctx: ContextWith<'quarantine'>,
  id: string,
  content: string,
): Promise<QuarantineEditResult> {
  if (ctx.actor.role !== 'admin') {
    throw new ForbiddenError('Only an admin key can edit a quarantined memory');
  }
  const edit = ctx.store.quarantine.editQuarantined?.bind(ctx.store.quarantine);
  if (!edit) throw new StoreNotPortedError(ctx.store.kind, 'quarantine.editQuarantined');
  const vetted = vetSecrets(content);
  const [held] = await ctx.store.entriesByIds([id], ctx.tenantId);
  const leadIn = held?.leadIn ?? null;
  // A row the store cannot find is refused there, with its own 404 text, so no screen answers first.
  const found = held ? detectInstructionIn({ content: vetted.content, leadIn }) : null;
  if (found?.flagged) {
    throw new BadRequestError(
      `edited text still reads as an instruction (${found.reason ?? 'unknown'}); nothing was changed`,
    );
  }
  const result = await edit(
    ctx.tenantId,
    id,
    {
      content: vetted.content,
      leadIn,
      tags: held?.tags ?? [],
      baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
    },
    ctx.actor.subject,
  );
  if (result.outcome !== 'edited') throw editRefusalError(id, result);
  const done: QuarantineEditResult = { edited: id, newId: result.newId };
  if (leadIn) done.keptLeadIn = leadIn;
  if (vetted.warnings.length > 0) done.warnings = vetted.warnings;
  return done;
}
