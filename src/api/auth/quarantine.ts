// Quarantine review: list, approve, edit and reject held memories.

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../base/errors/api-errors.js';
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { QuarantineRefusal } from '../../base/ports/store.js';
import { StoreNotPortedError } from '../../base/util/store-blocked.js';
import { vetSecrets } from '../../base/util/secret-detect.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import {
  detectInstruction,
  detectInstructionIn,
  instructionIn,
  UNTRUSTED_ORIGIN_TAG,
} from '../../domain/trust/instruction-detect.js';
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

// One answer for an id the edit cannot find, so a flagged text and a clean one tell a caller the same.
const UNKNOWN_EDIT_ID = 'is not quarantined or could not be read; nothing was changed';

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
    case 'not_quarantined':
      return new NotFoundError(`memory ${id} ${UNKNOWN_EDIT_ID}`);
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

/** The tags the successor stores, which the edit screens: every held tag in stored order, marks and
 * capture tags too, then the untrusted-origin mark if the row lacks it. A mark is screened with the
 * rest because the context line prints it, and `instruction-like` completes "ignore all previous". */
function successorTagsOf(held: MemoryEntry | undefined): string[] {
  return [...new Set([...(held?.tags ?? []), UNTRUSTED_ORIGIN_TAG])];
}

/** The 400 for a held row whose kept lead-in or stored tags read as an instruction: an edit keeps
 * both, so it cannot release it. */
function refuseKeptFlags(id: string, held: MemoryEntry, tags: readonly string[]): void {
  const lead = held.leadIn ? detectInstruction(held.leadIn) : null;
  if (lead?.flagged) {
    throw new BadRequestError(
      `the kept lead-in of memory ${id} reads as an instruction (${lead.reason ?? 'unknown'}); ` +
        'an edit keeps the lead-in, so it cannot release this item; nothing was changed',
    );
  }
  // No text: each tag, then the tags as a context line prints them.
  const found = instructionIn({ content: '' }, tags);
  if (found.flagged) {
    throw new BadRequestError(
      `the kept tags of memory ${id} read as an instruction (${found.reason ?? 'unknown'}); ` +
        'an edit keeps the tags, so it cannot release this item; nothing was changed',
    );
  }
}

/** The 400 or 404 a refused edit text answers before any write; else the tags the successor stores,
 * which it screened. A row the read missed is judged by the text alone, so a flagged text never
 * reaches the store. */
function screenEditText(id: string, text: string, held: MemoryEntry | undefined): string[] {
  const tags = successorTagsOf(held);
  if (!held) {
    if (detectInstruction(text).flagged) {
      throw new NotFoundError(`memory ${id} ${UNKNOWN_EDIT_ID}`);
    }
    return tags;
  }
  refuseKeptFlags(id, held, tags);
  const found = instructionIn({ content: text, leadIn: held.leadIn }, tags);
  if (!found.flagged) return tags;
  const reason = found.reason ?? 'unknown';
  if (detectInstruction(text).flagged) {
    throw new BadRequestError(
      `edited text still reads as an instruction (${reason}); nothing was changed`,
    );
  }
  const joined = detectInstructionIn({ content: text, leadIn: held.leadIn }).flagged
    ? 'lead-in'
    : 'tags';
  throw new BadRequestError(
    `the edited text of memory ${id} reads as an instruction when joined to its kept ${joined} (${reason}); ` +
      'nothing was changed',
  );
}

/** Release a quarantined memory with the admin's text, trimmed once, in place of the held text. Admin
 * only; the text runs the write screen again, and the held row stays as delivered. */
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
  const vetted = vetSecrets(content.trim());
  const [held] = await ctx.store.entriesByIds([id], ctx.tenantId);
  const tags = screenEditText(id, vetted.content, held);
  const leadIn = held?.leadIn ?? null;
  const result = await edit(
    ctx.tenantId,
    id,
    {
      content: vetted.content,
      leadIn,
      tags,
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
