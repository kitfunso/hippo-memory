import { MemoryEntry, EXTRACTED_TAG, Layer, isUserMessage } from '../../base/memory/entry.js';
import {
  calculateStrength,
  type DecayBasis,
  type StrengthModel,
} from '../../base/memory/strength.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import { isPersonalScope } from '../../base/scope/recall-scope.js';
import { CONFLICT_STOPWORDS } from '../../base/util/stopwords.js';
import { jaccardSets, tokenizeMin } from '../../base/util/tokenize.js';
import { DECAY_THRESHOLD } from './decay.js';
import type { DetectedConflict } from '../../base/ports/store/consolidation.js';
import type { ConflictSide, LoserFate } from '../../base/ports/store/conflicts.js';
import { BadRequestError } from '../../base/errors/api-errors.js';
import { isSuperseded } from '../../base/memory/liveness.js';

const CONFLICT_OVERLAP_THRESHOLD = 0.5;
const CONFLICT_MIN_RARE_SHARED = 2;
const POLARITY_WINDOW_WORDS = 40;

type PagesOf = (
  ids: readonly string[],
) => Iterable<readonly MemoryEntry[]> | AsyncIterable<readonly MemoryEntry[]>;

export interface DetectConflictsOptions {
  strength: StrengthModel;
  decayOpts?: DecayBasis;
  rescuedIds?: Set<string>;
  pagesOf?: PagesOf;
}

/** Pairs of live non-semantic memories that contradict each other, in survivor order. With
 * `pagesOf`, the rows are read back one tenant at a time, as a pair never spans tenants, so only
 * that tenant's profiles are held. */
export async function detectConflicts(
  entries: Iterable<MemoryEntry> | AsyncIterable<MemoryEntry>,
  now: Date,
  options: DetectConflictsOptions,
): Promise<DetectedConflict[]> {
  const { strength, decayOpts = {}, rescuedIds = new Set<string>(), pagesOf } = options;
  const held: MemoryEntry[] = [];
  const byTenant = new Map<string, number[]>();
  const ids: string[] = [];
  for await (const entry of entries) {
    const live =
      entry.layer !== Layer.Semantic &&
      !isQuarantineScope(entry.scope ?? null) &&
      !isUserMessage(entry) &&
      (rescuedIds.has(entry.id) ||
        calculateStrength(entry, now, strength, decayOpts) >= DECAY_THRESHOLD);
    if (!live) continue;
    const places = byTenant.get(entry.tenantId);
    if (places) places.push(ids.length);
    else byTenant.set(entry.tenantId, [ids.length]);
    ids.push(entry.id);
    if (!pagesOf) held.push(entry);
  }
  const found: Array<readonly [number, number, DetectedConflict]> = [];
  for (const places of byTenant.values()) {
    const rows = pagesOf
      ? await readPlaces(places, ids, pagesOf)
      : places.map((p) => conflictRow(p, held[p]));
    found.push(...tenantConflicts(rows));
  }
  return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , conflict]) => conflict);
}

interface ConflictRow {
  place: number;
  id: string;
  trace: boolean;
  superseded: boolean;
  restated: boolean;
  scope: MemoryEntry['scope'];
  tenantId: string;
  originProject: MemoryEntry['originProject'];
  profile: ConflictProfile;
}

function conflictRow(place: number, e: MemoryEntry): ConflictRow {
  return {
    place,
    id: e.id,
    trace: e.layer === Layer.Trace,
    superseded: isSuperseded(e),
    restated: e.tags.includes(EXTRACTED_TAG) || e.tags.includes('session-digest'),
    scope: e.scope,
    tenantId: e.tenantId,
    originProject: e.originProject,
    profile: conflictProfile(e.content),
  };
}

async function readPlaces(
  places: readonly number[],
  ids: readonly string[],
  pagesOf: PagesOf,
): Promise<ConflictRow[]> {
  const placeOf = new Map(places.map((p) => [ids[p], p]));
  const rows: ConflictRow[] = [];
  for await (const page of pagesOf(places.map((p) => ids[p]))) {
    for (const e of page) rows.push(conflictRow(placeOf.get(e.id)!, e));
  }
  return rows;
}

function tenantConflicts(
  rows: readonly ConflictRow[],
): Array<readonly [number, number, DetectedConflict]> {
  const partnersOf = overlapPartners(
    rows.map((r) => r.profile.distinct),
    jaccardMinShared(CONFLICT_OVERLAP_THRESHOLD, CONFLICT_MIN_RARE_SHARED),
  );
  const found: Array<readonly [number, number, DetectedConflict]> = [];
  for (const [i, a] of rows.entries()) {
    for (const j of partnersOf(i)) {
      const b = rows[j];
      if (
        (a.trace && b.trace) ||
        a.superseded ||
        b.superseded ||
        !recalledTogether(a, b) ||
        a.restated ||
        b.restated
      ) {
        continue;
      }
      const reasonAndScore = describeConflict(a.profile, b.profile);
      if (!reasonAndScore) continue;
      found.push([a.place, b.place, { memoryAId: a.id, memoryBId: b.id, ...reasonAndScore }]);
    }
  }
  return found;
}

type RecallFields = Pick<MemoryEntry, 'scope' | 'tenantId' | 'originProject'>;

function recalledTogether(a: RecallFields, b: RecallFields): boolean {
  if ((isPersonalScope(a.scope) || isPersonalScope(b.scope)) && a.scope !== b.scope) return false;
  if (a.tenantId !== b.tenantId) return false;
  const [x, y] = [a.originProject ?? null, b.originProject ?? null];
  return x === y || (x === '' && y !== null) || (y === '' && x !== null);
}

type ConflictPolarity = 'positive' | 'negative' | 'neutral';

interface ConflictProfile {
  readonly distinct: Set<string>;
  readonly polarity: ConflictPolarity;
  readonly window: string;
}

function conflictProfile(text: string): ConflictProfile {
  const opening = openingWindow(text);
  return {
    distinct: distinctiveTokens(text),
    polarity: inferConflictPolarity(opening),
    window: ' ' + opening.toLowerCase() + ' ',
  };
}

function describeConflict(
  a: ConflictProfile,
  b: ConflictProfile,
): { reason: string; score: number } | null {
  const overlapScore = jaccardSets(a.distinct, b.distinct);

  let shared = 0;
  for (const t of a.distinct) if (b.distinct.has(t)) shared++;
  if (shared < CONFLICT_MIN_RARE_SHARED) return null;

  const conflictType = classifyConflictType(a.window, b.window, a.polarity, b.polarity);
  if (!conflictType) return null;

  if (overlapScore < CONFLICT_OVERLAP_THRESHOLD) return null;

  return {
    reason: conflictType,
    score: overlapScore,
  };
}

function distinctiveTokens(text: string): Set<string> {
  return new Set(tokenizeMin(text, 3).filter((t) => !CONFLICT_STOPWORDS.has(t)));
}

function openingWindow(text: string): string {
  return text.split(/\s+/).slice(0, POLARITY_WINDOW_WORDS).join(' ');
}

function classifyConflictType(
  a: string,
  b: string,
  aPolarity: ConflictPolarity,
  bPolarity: ConflictPolarity,
): string | null {
  const enabledDisabled =
    (containsAny(a, [' enabled ', ' enable ']) && containsAny(b, [' disabled ', ' disable '])) ||
    (containsAny(b, [' enabled ', ' enable ']) && containsAny(a, [' disabled ', ' disable ']));
  if (enabledDisabled) return 'enabled/disabled mismatch on overlapping statement';

  const trueFalse =
    (containsAny(a, [' true ', ' true.', ' true,', ' yes ']) &&
      containsAny(b, [' false ', ' false.', ' false,', ' no '])) ||
    (containsAny(b, [' true ', ' true.', ' true,', ' yes ']) &&
      containsAny(a, [' false ', ' false.', ' false,', ' no ']));
  if (trueFalse) return 'true/false mismatch on overlapping statement';

  const alwaysNever =
    (containsAny(a, [' always ', ' must ']) && containsAny(b, [' never ', ' must not '])) ||
    (containsAny(b, [' always ', ' must ']) && containsAny(a, [' never ', ' must not ']));
  if (alwaysNever) return 'always/never mismatch on overlapping statement';

  if (
    (aPolarity === 'positive' && bPolarity === 'negative') ||
    (aPolarity === 'negative' && bPolarity === 'positive')
  ) {
    return 'negation polarity mismatch on overlapping statement';
  }

  return null;
}

function inferConflictPolarity(text: string): ConflictPolarity {
  const lowered = ` ${text.toLowerCase()} `;
  const negativePatterns = [
    ' not ',
    ' never ',
    ' no ',
    " don't ",
    ' do not ',
    " doesn't ",
    ' does not ',
    " can't ",
    ' cannot ',
    " shouldn't ",
    ' should not ',
    ' disabled ',
    ' disable ',
    ' off ',
    ' false ',
    ' missing ',
    ' broken ',
    ' failed ',
  ];
  const positivePatterns = [
    ' enabled ',
    ' enable ',
    ' works ',
    ' working ',
    ' true ',
    ' available ',
    ' present ',
    ' on ',
    ' always ',
    ' must ',
  ];

  if (containsAny(lowered, negativePatterns)) return 'negative';
  if (containsAny(lowered, positivePatterns)) return 'positive';
  return 'neutral';
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

/** A weakened loser keeps this share of its half-life, so it fades faster than the kept side. */
export const WEAKEN_HALF_LIFE_FACTOR = 0.5;
/** A weakened loser's half-life never drops under this, so repeated resolves cannot drive it to
 * zero. */
export const WEAKEN_MIN_HALF_LIFE_DAYS = 1;

/** What the caller asked for the loser: forget deletes it, rejectLoser also tombstones its
 * value. */
export interface LoserChoice {
  readonly forget?: boolean;
  readonly rejectLoser?: boolean;
}

/** The loser's fate, every number in it: a store applies it as given. A rejection is a
 * tenant-wide tombstone, so it may not carry a personal row's value, and its sweep stays within
 * `ownScope`, what the caller may touch. */
export function conflictLoserFate(
  choice: LoserChoice,
  loser: ConflictSide,
  ownScope: string | null,
): LoserFate {
  if (choice.rejectLoser !== true) {
    if (choice.forget === true) return { kind: 'remove' };
    return {
      kind: 'weaken',
      halfLifeFactor: WEAKEN_HALF_LIFE_FACTOR,
      minHalfLifeDays: WEAKEN_MIN_HALF_LIFE_DAYS,
    };
  }
  if (isPersonalScope(loser.scope)) {
    throw new BadRequestError(
      `cannot reject the value of personal memory ${loser.id}: a rejection reaches the whole tenant, ` +
        `so its reason would show to everyone; resolve with forget instead`,
    );
  }
  return { kind: 'reject', ownScope };
}
