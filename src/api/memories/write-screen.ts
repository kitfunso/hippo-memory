// The one screen every caller's write of new text runs: who is screened, what the instruction check finds, and
// whether the row is held for review or kept framed. remember, rememberUntrusted and supersede call it.
import type { ConnectorWrite, ConnectorWrites } from '../../base/ports/store.js';
import { isPersonalScope } from '../../base/scope/recall-scope.js';
import { quarantineScopeFor } from '../../domain/trust/quarantine.js';
import {
  detectInstruction,
  INSTRUCTION_LIKE_TAG,
  type InstructionDetection,
  UNTRUSTED_ORIGIN_TAG,
} from '../instruction-detect.js';
import type { Actor, ContextWith } from '../types.js';

/** The groups that hold a flagged write: the write that commits its review record, and the
 * queue it is released from. */
export type ReviewGroup = 'connectorWrites' | 'quarantine';

/** The group that writes a held row with its review record; undefined on a store with no queue to release it. */
export function reviewerOf(ctx: ContextWith<never, ReviewGroup>): ConnectorWrites | undefined {
  return ctx.store.quarantine ? ctx.store.connectorWrites : undefined;
}

export interface ScreenInput {
  /** The text the row stores. */
  readonly content: string;
  /** The caller's own tags, screened like the content; never the marks or system tags code adds. */
  readonly tags?: readonly string[];
  /** The scope the caller asked for. */
  readonly scope: string | null;
  /** Connector content an agent doesn't control: always screened, and tagged with its origin. */
  readonly untrusted: boolean;
  /** A connector's own rule that holds the write whatever the check finds; read only when `untrusted`. */
  readonly rule?: { readonly reason: string };
  /** The store writes a review record beside a held row. */
  readonly holds: boolean;
}

export interface ScreenVerdict {
  /** The scope to write: the one asked for, or its quarantine scope when held. */
  readonly scope: string | null;
  /** Tags the row adds to its own. */
  readonly marks: readonly string[];
  /** The review record of a held write. */
  readonly quarantine: ConnectorWrite['quarantine'];
}

const NOT_FLAGGED: InstructionDetection = { flagged: false, reason: null };

export function screenWrite(actor: Actor, input: ScreenInput): ScreenVerdict {
  const screened = input.untrusted || sharesAsMember(actor, input.scope);
  const detection = screened ? firstFlagged([input.content, ...(input.tags ?? [])]) : NOT_FLAGGED;
  // Only a connector's rule may hold a write; a client body never reaches `rule`.
  const reason = holdReason(detection, input.untrusted ? input.rule : undefined);
  const quarantine =
    input.holds && reason !== null ? { originalScope: input.scope, reason } : undefined;
  const marks = [
    ...(input.untrusted ? [UNTRUSTED_ORIGIN_TAG] : []),
    ...(!input.untrusted && detection.flagged ? [INSTRUCTION_LIKE_TAG] : []),
  ];
  return { scope: quarantine ? quarantineScopeFor(input.scope) : input.scope, marks, quarantine };
}

function firstFlagged(texts: readonly string[]): InstructionDetection {
  for (const text of texts) {
    const found = detectInstruction(text);
    if (found.flagged) return found;
  }
  return NOT_FLAGGED;
}

/** `tags` plus each mark it lacks. */
export function markedTags(
  tags: string[] | undefined,
  marks: readonly string[],
): string[] | undefined {
  const added = marks.filter((mark) => !(tags ?? []).includes(mark));
  return added.length > 0 ? [...(tags ?? []), ...added] : tags;
}

/** A member key's write outside a personal scope reaches the other members' prompts, as connector text does;
 * the local key is the operator's own CLI. */
function sharesAsMember(actor: Actor, scope: string | null): boolean {
  return actor.role === 'member' && actor.localKey !== true && !isPersonalScope(scope);
}

/** Why a write is held: the check's match, the connector's rule, or both; null when neither. */
function holdReason(detection: InstructionDetection, rule: ScreenInput['rule']): string | null {
  const reasons = [
    ...(detection.flagged ? [detection.reason ?? 'unknown'] : []),
    ...(rule ? [rule.reason] : []),
  ];
  return reasons.length > 0 ? reasons.join('; ') : null;
}
