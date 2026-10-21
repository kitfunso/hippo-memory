import { MemoryEntry, Layer, calculateStrength, type DecayOptions } from '../../base/memory/memory.js';
import { jaccardMinShared, overlapPartners } from './overlap-index.js';
import { isQuarantineScope } from '../trust/quarantine.js';
import { isPersonalScope } from '../../base/scope/recall-scope.js';
import { CONFLICT_STOPWORDS } from '../../base/util/stopwords.js';
import { jaccardSets, tokenize } from '../../base/util/tokenize.js';
import { DECAY_THRESHOLD } from './decay.js';
import type { DetectedConflict } from '../../store/port/consolidation.js';

// Gate contradictions on content overlap, not shared tags (`feedback`/`policy` are too coarse). The Jaccard threshold
// on stopword-filtered tokens only applies after a polarity signal, so it filters drive-by topic similarity, not
// semantic drift.
const CONFLICT_OVERLAP_THRESHOLD = 0.5;
// Minimum distinctive shared tokens before we trust an overlap score. Filters out cases where two memories share only
// common English + a project name.
const CONFLICT_MIN_RARE_SHARED = 2;
// Polarity is detected on the first N words only. A stray "not" in the middle of a long memory shouldn't flip the whole
// thing negative.
const POLARITY_WINDOW_WORDS = 40;

/** Reads back the rows for `ids`, a page at a time; an id gone since is skipped. */
type PagesOf = (ids: readonly string[]) => Iterable<readonly MemoryEntry[]> | AsyncIterable<readonly MemoryEntry[]>;

export interface DetectConflictsOptions {
  decayOpts?: DecayOptions;
  // Ids this cycle's decay pass rescued: the survivor filter below is recomputed independently, so without this bypass
  // rescued entries would be silently re-excluded from conflict detection.
  rescuedIds?: Set<string>;
  pagesOf?: PagesOf;
}

/** Pairs of live non-semantic memories that contradict each other, in survivor order. With `pagesOf`, the rows are read
 * back one tenant at a time, as a pair never spans tenants, so only that tenant's profiles are held. */
export async function detectConflicts(
  entries: Iterable<MemoryEntry> | AsyncIterable<MemoryEntry>,
  now: Date,
  options: DetectConflictsOptions = {},
): Promise<DetectedConflict[]> {
  const { decayOpts = {}, rescuedIds = new Set<string>(), pagesOf } = options;
  const held: MemoryEntry[] = [];
  const byTenant = new Map<string, number[]>();
  const ids: string[] = [];
  for await (const entry of entries) {
    const live =
      entry.layer !== Layer.Semantic &&
      // An unreviewed quarantined row must not taint a visible memory as conflicted.
      !isQuarantineScope(entry.scope ?? null) &&
      (rescuedIds.has(entry.id) || calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD);
    if (!live) continue;
    const places = byTenant.get(entry.tenantId);
    if (places) places.push(ids.length);
    else byTenant.set(entry.tenantId, [ids.length]);
    ids.push(entry.id);
    if (!pagesOf) held.push(entry);
  }
  const found: Array<readonly [number, number, DetectedConflict]> = [];
  for (const places of byTenant.values()) {
    const rows = pagesOf ? await readPlaces(places, ids, pagesOf) : places.map((p) => conflictRow(p, held[p]));
    found.push(...tenantConflicts(rows));
  }
  return found.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , conflict]) => conflict);
}

/** What the pair checks read of one live row, and its place in survivor order. */
interface ConflictRow {
  place: number;
  id: string;
  trace: boolean;
  superseded: boolean;
  /** Extracted facts and session digests restate other rows, so they are never one side of a conflict. */
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
    superseded: Boolean(e.supersededBy),
    restated: e.tags.includes('extracted') || e.tags.includes('session-digest'),
    scope: e.scope,
    tenantId: e.tenantId,
    originProject: e.originProject,
    profile: conflictProfile(e.content),
  };
}

async function readPlaces(places: readonly number[], ids: readonly string[], pagesOf: PagesOf): Promise<ConflictRow[]> {
  const placeOf = new Map(places.map((p) => [ids[p], p]));
  const rows: ConflictRow[] = [];
  for await (const page of pagesOf(places.map((p) => ids[p]))) {
    for (const e of page) rows.push(conflictRow(placeOf.get(e.id)!, e));
  }
  return rows;
}

/** One tenant's conflicts, each with the survivor places of its two sides. */
function tenantConflicts(rows: readonly ConflictRow[]): Array<readonly [number, number, DetectedConflict]> {
  const partnersOf = overlapPartners(
    rows.map((r) => r.profile.distinct),
    jaccardMinShared(CONFLICT_OVERLAP_THRESHOLD, CONFLICT_MIN_RARE_SHARED),
  );
  const found: Array<readonly [number, number, DetectedConflict]> = [];
  for (const [i, a] of rows.entries()) {
    for (const j of partnersOf(i)) {
      const b = rows[j];
      // Traces are variants of each other, not contradictions: two strategies for the same task can both be valid, and
      // conflict detection is for stated-rule disagreement, not strategy diversity.
      if ((a.trace && b.trace) || a.superseded || b.superseded || !recalledTogether(a, b) || a.restated || b.restated) {
        continue;
      }
      const reasonAndScore = describeConflict(a.profile, b.profile);
      if (!reasonAndScore) continue;
      found.push([a.place, b.place, { memory_a_id: a.id, memory_b_id: b.id, ...reasonAndScore }]);
    }
  }
  return found;
}

type RecallFields = Pick<MemoryEntry, 'scope' | 'tenantId' | 'originProject'>;

/** One project's ambient context can show both: same tenant, and the same project or a user-global row beside a
 * project's. */
function recalledTogether(a: RecallFields, b: RecallFields): boolean {
  // A personal row pairs only inside its own scope; any other pair shows its id to someone else.
  if ((isPersonalScope(a.scope) || isPersonalScope(b.scope)) && a.scope !== b.scope) return false;
  if (a.tenantId !== b.tenantId) return false;
  const [x, y] = [a.originProject ?? null, b.originProject ?? null];
  return x === y || (x === '' && y !== null) || (y === '' && x !== null);
}

type ConflictPolarity = 'positive' | 'negative' | 'neutral';

interface ConflictProfile {
  readonly distinct: Set<string>;
  readonly polarity: ConflictPolarity;
  /** Lowercased opening window padded with spaces, as classifyConflictType matches it. */
  readonly window: string;
}

function conflictProfile(text: string): ConflictProfile {
  const opening = openingWindow(text);
  // Polarity is measured only in the first POLARITY_WINDOW_WORDS, so a stray negation deep in a prose memory doesn't
  // flip the intent.
  // Pad with spaces so space-delimited patterns match words at the start/end.
  return {
    distinct: distinctiveTokens(text),
    polarity: inferConflictPolarity(opening),
    window: ' ' + opening.toLowerCase() + ' ',
  };
}

function describeConflict(a: ConflictProfile, b: ConflictProfile): { reason: string; score: number } | null {
  // Jaccard on stopword-stripped tokens. Defer the threshold check until we know whether an explicit polarity pair is
  // present (lower bar for those).
  const overlapScore = jaccardSets(a.distinct, b.distinct);

  // Require at least N shared distinctive tokens so two short memories sharing only "the project name" don't register.
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
  return new Set(tokenize(text).filter((t) => t.length > 2 && !CONFLICT_STOPWORDS.has(t)));
}

function openingWindow(text: string): string {
  return text.split(/\s+/).slice(0, POLARITY_WINDOW_WORDS).join(' ');
}

// Takes opening windows only, so " on " and " off " as prepositions deep in long prose don't read as enabled/disabled.
function classifyConflictType(
  a: string,
  b: string,
  aPolarity: ConflictPolarity,
  bPolarity: ConflictPolarity,
): string | null {
  // Whole-word boundaries so " on " alone doesn't match "on/off"; pair only `enabled` <-> `disabled` and explicit
  // on/off in imperative context.
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
