/**
 * Decision object: the `decisions` table is the source of truth, so an in-force decision stays
 * `active` despite memory decay. The memory mirror (memory_id NULLABLE, ON DELETE SET NULL) is for
 * recall only; saveDecision commits both in one `objects` transaction.
 */

import type { MemoryEntry } from '../../base/memory/entry.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import type { KeysetPosition } from '../../base/util/keyset.js';
import { MAX_SHORT_FIELD_LEN } from '../../base/util/limits.js';
import type { EntryWrites } from '../../base/ports/store.js';
import type { Objects } from '../../base/records/objects.js';
import type { SavableDescriptor } from './descriptor.js';
import { requireText } from './fields.js';
import { listObjects } from './lifecycle.js';
import type { Decision, DecisionStatus } from '../../base/records/object-types.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';

export type { Decision, DecisionStatus } from '../../base/records/object-types.js';

const SUPERSEDED_TAG = 'superseded';

export const VALID_DECISION_STATES: ReadonlySet<DecisionStatus> = new Set<DecisionStatus>([
  'active',
  'superseded',
  'closed',
]);

export interface SaveDecisionOptions {
  decisionText: string;
  context?: string;
  /** Table id of an ACTIVE decision this one supersedes; the CLI resolves a `--supersedes <memory-id>` via
   *  resolveActiveDecisionIdByMemory, HTTP/SDK pass the table id. */
  supersedesDecisionId?: number;
  /** Extra memory tags merged after ['decision'] (the CLI passes path-context tags; HTTP/SDK
   * pass none). */
  extraTags?: string[];
}

export interface ListDecisionsOptions {
  status?: DecisionStatus;
  limit?: number;
  /** Resume after this row: the position the previous page ended on. */
  after?: KeysetPosition;
}

export const DECISION: SavableDescriptor<'decision', SaveDecisionOptions> = {
  kind: 'decision',
  label: 'decision',
  plural: 'decisions',
  states: VALID_DECISION_STATES,
  closableFrom: ['active'],
  draft(opts, now) {
    const decisionText = requireText(opts.decisionText, MAX_SHORT_FIELD_LEN, 'decisionText');
    return {
      fields: { decisionText, context: opts.context },
      content: opts.context ? `${decisionText}\n\nContext: ${opts.context}` : decisionText,
      tags: opts.extraTags ?? [],
      supersedesId: opts.supersedesDecisionId,
      at: now.toISOString(),
    };
  },
};

/**
 * Weaken the memory a new decision replaces, once the save has committed: half-life halved to a day
 * at least, marked stale, tagged `superseded`.
 */
export function weakenSupersededMemory(
  writes: EntryWrites,
  entry: MemoryEntry,
  actor: string = CLI_ACTOR,
): Promise<void> {
  const tags = entry.tags.includes(SUPERSEDED_TAG) ? entry.tags : [...entry.tags, SUPERSEDED_TAG];
  const halved = Math.max(1, Math.floor(entry.halfLifeDays / 2));
  return writes.writeEntry({
    entry: { ...entry, halfLifeDays: halved, confidence: 'stale', tags },
    actor,
  });
}

export function loadDecisions(
  objects: Objects,
  tenantId: string,
  opts: ListDecisionsOptions = {},
): Promise<Decision[]> {
  return listObjects(objects, DECISION, tenantId, opts);
}

/** Resolve a `--supersedes <memory-id>` to the table id of the ACTIVE decision backed by that memory, or null.
 *  Exported so the CLI's backward-compat path is testable at the store layer. */
export async function resolveActiveDecisionIdByMemory(
  objects: Objects,
  tenantId: string,
  memoryId: string,
): Promise<number | null> {
  assertTenantId('resolveActiveDecisionIdByMemory', tenantId);
  const [row] = await objects.listObjects(tenantId, 'decision', {
    status: 'active',
    memoryId,
    limit: 1,
  });
  return row ? row.id : null;
}
