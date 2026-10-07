import { MemoryEntry, Layer, calculateStrength, type DecayOptions } from '../memory.js';
import { jaccardMinShared, overlapPartners } from '../overlap-index.js';
import { isQuarantineScope } from '../quarantine.js';
import { isPersonalScope } from '../recall-scope.js';
import { DECAY_THRESHOLD } from './decay.js';

// Contradictions should be gated by content overlap, not shared tags. Tags like
// `feedback` / `policy` are too coarse and can make unrelated rules look like
// conflicts before the polarity heuristics run.
// Jaccard threshold on stopword-filtered tokens. Only applied after a polarity
// signal has already been detected (explicit pair or inferred negation), so
// this just filters out drive-by topic similarity, not semantic drift.
const CONFLICT_OVERLAP_THRESHOLD = 0.5;
// Minimum distinctive shared tokens before we trust an overlap score. Filters
// out cases where two memories share only common English + a project name.
const CONFLICT_MIN_RARE_SHARED = 2;
// Polarity is detected on the first N words only. A stray "not" in the middle
// of a long memory shouldn't flip the whole thing negative.
const POLARITY_WINDOW_WORDS = 40;

const CONFLICT_STOPWORDS = new Set([
  'the','a','an','is','was','are','were','be','been','being','to','of','in',
  'for','on','with','at','by','from','it','this','that','and','or','but','so',
  'if','as','we','i','you','they','he','she','my','our','your','its','his',
  'her','their','up','out','just','also','then','than','some','all','any',
  'each','very','too','do','did','does','has','had','have','will','would',
  'could','should','may','might','can','shall','when','where','what','which',
  'who','how','why','there','here','about','into','over','after','before',
  'between','through','during','against','within','without','toward','upon',
  'more','most','less','least','other','such','same','new','old','one','two',
]);

/** Pairs of live non-semantic memories that contradict each other, in survivor order. */
export function detectConflicts(
  entries: MemoryEntry[],
  now: Date,
  decayOpts: DecayOptions = {},
  // Ids this cycle's decay pass rescued: the survivor filter below is recomputed independently, so
  // without this bypass rescued entries would be silently re-excluded from conflict detection.
  rescuedIds: Set<string> = new Set(),
): Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> {
  const survivors = entries.filter(
    (entry) =>
      entry.layer !== Layer.Semantic
      // An unreviewed quarantined row must not taint a visible memory as conflicted.
      && !isQuarantineScope(entry.scope ?? null)
      && (rescuedIds.has(entry.id) || calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD),
  );
  const detected: Array<{ memory_a_id: string; memory_b_id: string; reason: string; score: number }> = [];
  const profiles = survivors.map((entry) => conflictProfile(entry.content));
  const partnersOf = overlapPartners(
    profiles.map((p) => p.distinct),
    jaccardMinShared(CONFLICT_OVERLAP_THRESHOLD, CONFLICT_MIN_RARE_SHARED),
  );

  for (let i = 0; i < survivors.length; i++) {
    for (const j of partnersOf(i)) {
      // Traces are variants of each other, not contradictions. Two
      // strategies for the same task can both be valid; conflict detection
      // exists for stated-rule disagreement, not strategy diversity.
      if (survivors[i].layer === Layer.Trace && survivors[j].layer === Layer.Trace) continue;
      if (survivors[i].superseded_by || survivors[j].superseded_by) continue;
      if (!recalledTogether(survivors[i], survivors[j])) continue;
      if ([survivors[i], survivors[j]].some((e) => e.tags.includes('extracted') || e.tags.includes('session-digest'))) continue;
      const reasonAndScore = describeConflict(profiles[i], profiles[j]);
      if (!reasonAndScore) continue;
      detected.push({
        memory_a_id: survivors[i].id,
        memory_b_id: survivors[j].id,
        reason: reasonAndScore.reason,
        score: reasonAndScore.score,
      });
    }
  }

  return detected;
}

/** One project's ambient context can show both: same tenant, and the same project or a user-global row beside a project's. */
function recalledTogether(a: MemoryEntry, b: MemoryEntry): boolean {
  // A personal row pairs only inside its own scope; any other pair shows its id to someone else.
  if ((isPersonalScope(a.scope) || isPersonalScope(b.scope)) && a.scope !== b.scope) return false;
  if (a.tenantId !== b.tenantId) return false;
  const [x, y] = [a.origin_project ?? null, b.origin_project ?? null];
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
  // Polarity is measured only in the first POLARITY_WINDOW_WORDS, so a stray
  // negation deep in a prose memory doesn't flip the intent.
  // Pad with spaces so space-delimited patterns match words at the start/end.
  return { distinct: distinctiveTokens(text), polarity: inferConflictPolarity(opening), window: ' ' + opening.toLowerCase() + ' ' };
}

function describeConflict(a: ConflictProfile, b: ConflictProfile): { reason: string; score: number } | null {
  // Jaccard on stopword-stripped tokens. Defer the threshold check until we
  // know whether an explicit polarity pair is present (lower bar for those).
  const overlapScore = jaccardSets(a.distinct, b.distinct);

  // Require at least N shared distinctive tokens so two short memories sharing
  // only "the project name" don't register.
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
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !CONFLICT_STOPWORDS.has(t)),
  );
}

export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
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
  // Tightened tokens: require whole-word boundaries so " on " alone doesn't
  // match "on/off". Pair only `enabled` ↔ `disabled` and explicit on/off in
  // imperative context.
  const enabledDisabled =
    (containsAny(a, [' enabled ', ' enable ']) && containsAny(b, [' disabled ', ' disable ']))
    || (containsAny(b, [' enabled ', ' enable ']) && containsAny(a, [' disabled ', ' disable ']));
  if (enabledDisabled) return 'enabled/disabled mismatch on overlapping statement';

  const trueFalse = (containsAny(a, [' true ', ' true.', ' true,', ' yes ']) && containsAny(b, [' false ', ' false.', ' false,', ' no ']))
    || (containsAny(b, [' true ', ' true.', ' true,', ' yes ']) && containsAny(a, [' false ', ' false.', ' false,', ' no ']));
  if (trueFalse) return 'true/false mismatch on overlapping statement';

  const alwaysNever = (containsAny(a, [' always ', ' must ']) && containsAny(b, [' never ', ' must not ']))
    || (containsAny(b, [' always ', ' must ']) && containsAny(a, [' never ', ' must not ']));
  if (alwaysNever) return 'always/never mismatch on overlapping statement';

  if ((aPolarity === 'positive' && bPolarity === 'negative') || (aPolarity === 'negative' && bPolarity === 'positive')) {
    return 'negation polarity mismatch on overlapping statement';
  }

  return null;
}

function inferConflictPolarity(text: string): ConflictPolarity {
  const lowered = ` ${text.toLowerCase()} `;
  const negativePatterns = [
    ' not ', ' never ', ' no ', " don't ", ' do not ', " doesn't ", ' does not ',
    " can't ", ' cannot ', " shouldn't ", ' should not ', ' disabled ', ' disable ', ' off ',
    ' false ', ' missing ', ' broken ', ' failed ',
  ];
  const positivePatterns = [
    ' enabled ', ' enable ', ' works ', ' working ', ' true ', ' available ', ' present ', ' on ',
    ' always ', ' must ',
  ];

  if (containsAny(lowered, negativePatterns)) return 'negative';
  if (containsAny(lowered, positivePatterns)) return 'positive';
  return 'neutral';
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}
