import type { LeadInText } from '../../base/memory/lead-in.js';
import type { ConnectorWrite, ConnectorWrites } from '../../base/ports/store.js';
import { isPersonalScope } from '../../base/scope/recall-scope.js';
import { quarantineScopeFor } from '../../domain/trust/quarantine.js';
import {
  INSTRUCTION_LIKE_TAG,
  instructionIn,
  type InstructionDetection,
  UNTRUSTED_ORIGIN_TAG,
} from '../../domain/trust/instruction-detect.js';
import type { Actor, ContextWith } from '../types.js';

/** The groups that hold a flagged write: the write that commits its review record, and the
 * queue it is released from. */
export type ReviewGroup = 'connectorWrites' | 'quarantine';

/** The group that writes a held row with its review record; undefined on a store with no queue to release it. */
export function reviewerOf(ctx: ContextWith<never, ReviewGroup>): ConnectorWrites | undefined {
  return ctx.store.quarantine ? ctx.store.connectorWrites : undefined;
}

export interface ScreenInput {
  readonly text: LeadInText;
  readonly tags?: readonly string[];
  readonly scope: string | null;
  readonly untrusted: boolean;
  readonly rule?: { readonly reason: string };
  readonly holds: boolean;
}

export interface ScreenVerdict {
  readonly scope: string | null;
  readonly marks: readonly string[];
  readonly quarantine: ConnectorWrite['quarantine'];
}

const NOT_FLAGGED: InstructionDetection = { flagged: false, reason: null };

export function screenWrite(actor: Actor, input: ScreenInput): ScreenVerdict {
  const screened = input.untrusted || sharesAsMember(actor, input.scope);
  const tags = input.tags ?? [];
  const detection = screened ? instructionIn(input.text, tags) : NOT_FLAGGED;
  const reason = holdReason(detection, input.untrusted ? input.rule : undefined);
  const quarantine =
    input.holds && reason !== null ? { originalScope: input.scope, reason } : undefined;
  const marks = [
    ...(input.untrusted ? [UNTRUSTED_ORIGIN_TAG] : []),
    ...(!input.untrusted && detection.flagged ? [INSTRUCTION_LIKE_TAG] : []),
  ];
  return { scope: quarantine ? quarantineScopeFor(input.scope) : input.scope, marks, quarantine };
}

/** `tags` plus each mark it lacks. */
export function markedTags(
  tags: string[] | undefined,
  marks: readonly string[],
): string[] | undefined {
  const added = marks.filter((mark) => !(tags ?? []).includes(mark));
  return added.length > 0 ? [...(tags ?? []), ...added] : tags;
}

function sharesAsMember(actor: Actor, scope: string | null): boolean {
  return actor.role !== 'admin' && actor.localKey !== true && !isPersonalScope(scope);
}

function holdReason(detection: InstructionDetection, rule: ScreenInput['rule']): string | null {
  const reasons = [
    ...(detection.flagged ? [detection.reason ?? 'unknown'] : []),
    ...(rule ? [rule.reason] : []),
  ];
  return reasons.length > 0 ? reasons.join('; ') : null;
}
