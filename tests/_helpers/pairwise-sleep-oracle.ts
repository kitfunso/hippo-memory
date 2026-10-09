// The all-pairs conflict and merge-partner passes sleep ran before the inverted index; kept as the oracle the indexed versions must match.
import { calculateStrength, Layer, type DecayOptions, type MemoryEntry } from '../../src/core/memory.js';
import { isQuarantineScope } from '../../src/trust/quarantine.js';
import { textOverlap } from '../../src/util/tokenize.js';

const DECAY_THRESHOLD = 0.05;
const MERGE_OVERLAP_THRESHOLD = 0.35;
const CONFLICT_OVERLAP_THRESHOLD = 0.5;
const CONFLICT_MIN_RARE_SHARED = 2;
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

export type DetectedConflict = { memory_a_id: string; memory_b_id: string; reason: string; score: number };

/** For each i, the j > i (ascending) whose textOverlap with i reaches the merge threshold. */
export function pairwiseMergePartners(contents: readonly string[]): number[][] {
  return contents.map((a, i) => {
    const out: number[] = [];
    for (let j = i + 1; j < contents.length; j++) if (textOverlap(a, contents[j]) >= MERGE_OVERLAP_THRESHOLD) out.push(j);
    return out;
  });
}

export function pairwiseDetectConflicts(
  entries: MemoryEntry[],
  now: Date,
  decayOpts: DecayOptions = {},
  rescuedIds: Set<string> = new Set(),
): DetectedConflict[] {
  const survivors = entries.filter(
    (entry) =>
      entry.layer !== Layer.Semantic
      && !isQuarantineScope(entry.scope ?? null)
      && (rescuedIds.has(entry.id) || calculateStrength(entry, now, decayOpts) >= DECAY_THRESHOLD),
  );
  const detected: DetectedConflict[] = [];
  for (let i = 0; i < survivors.length; i++) {
    for (let j = i + 1; j < survivors.length; j++) {
      if (survivors[i].layer === Layer.Trace && survivors[j].layer === Layer.Trace) continue;
      if (survivors[i].superseded_by || survivors[j].superseded_by) continue;
      if ([survivors[i], survivors[j]].some((e) => e.tags.includes('extracted') || e.tags.includes('session-digest'))) continue;
      const reasonAndScore = describeConflict(survivors[i], survivors[j]);
      if (!reasonAndScore) continue;
      detected.push({ memory_a_id: survivors[i].id, memory_b_id: survivors[j].id, reason: reasonAndScore.reason, score: reasonAndScore.score });
    }
  }
  return detected;
}

function describeConflict(a: MemoryEntry, b: MemoryEntry): { reason: string; score: number } | null {
  const aDistinct = distinctiveTokens(a.content);
  const bDistinct = distinctiveTokens(b.content);
  const overlapScore = jaccardSets(aDistinct, bDistinct);
  let shared = 0;
  for (const t of aDistinct) if (bDistinct.has(t)) shared++;
  if (shared < CONFLICT_MIN_RARE_SHARED) return null;
  const polarityA = inferConflictPolarity(openingWindow(a.content));
  const polarityB = inferConflictPolarity(openingWindow(b.content));
  const conflictType = classifyConflictType(a.content, b.content, polarityA, polarityB);
  if (!conflictType) return null;
  if (overlapScore < CONFLICT_OVERLAP_THRESHOLD) return null;
  return { reason: conflictType, score: overlapScore };
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

function jaccardSets(a: Set<string>, b: Set<string>): number {
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

function classifyConflictType(
  aText: string,
  bText: string,
  aPolarity: 'positive' | 'negative' | 'neutral',
  bPolarity: 'positive' | 'negative' | 'neutral',
): string | null {
  const a = ' ' + openingWindow(aText).toLowerCase() + ' ';
  const b = ' ' + openingWindow(bText).toLowerCase() + ' ';
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

function inferConflictPolarity(text: string): 'positive' | 'negative' | 'neutral' {
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
