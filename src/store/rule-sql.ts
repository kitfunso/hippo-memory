// The SQL twins of the model's strength and keep rules (src/core/memory.ts); keep in step with calculateStrength and canAutoDelete.
import { DAY_MS } from '../util/time.js';
import { isDecayAblated, isOutcomeSlowAblated, isRecallBoostAblated } from '../core/ablation.js';
import {
  DECAY_BASE, EMOTIONAL_MULTIPLIERS, KEEP_PAIRS, MAX_WRONG_HALVINGS, RETRIEVAL_BOOST_SLOPE, REWARD_SLOPE,
  applyLossAversionRatio, type EmotionalValence, type KeepPair,
} from '../core/memory.js';

const SQL_DEFAULT_HALF_LIFE_DAYS = 7;
const UNIX_EPOCH_JULIAN_DAY = 2440587.5;

/** calculateStrength's clock-basis formula as SQL over `memories` columns, flags and multipliers baked in; keep in step.
 *  An unparseable date scores NULL here and 0 in JS, so sums agree. */
export function strengthSql(now: Date): string {
  const num = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  const pos = 'COALESCE(outcome_positive, 0)';
  const neg = 'COALESCE(outcome_negative, 0)';
  const wrong = isOutcomeSlowAblated() || isDecayAblated() ? '0' : `MAX(0, ${neg} - ${pos})`;
  const reward = isOutcomeSlowAblated()
    ? '1.0'
    : `(CASE WHEN ${pos} = 0 AND ${neg} = 0 THEN 1.0 ELSE 1.0 + ${REWARD_SLOPE} * (${pos} - ${neg}) / (${pos} + ${neg} + 1.0) END)`;
  const halfLife = `(COALESCE(half_life_days, ${SQL_DEFAULT_HALF_LIFE_DAYS}) * ${reward})`;
  const anchor = isRecallBoostAblated() ? 'created' : 'last_retrieved';
  const nowJulian = num(now.getTime() / DAY_MS + UNIX_EPOCH_JULIAN_DAY);
  const decay = isDecayAblated() ? '1.0' : `pow(${DECAY_BASE}, (${nowJulian} - julianday(${anchor})) / ${halfLife})`;
  const boost = isRecallBoostAblated()
    ? '1.0'
    : `(CASE WHEN ${wrong} > 0 THEN 1.0 ELSE 1.0 + ${RETRIEVAL_BOOST_SLOPE} * log2(COALESCE(retrieval_count, 0) + 1) END)`;
  const valences = /* SAFETY: a Record keyed by EmotionalValence */ Object.keys(EMOTIONAL_MULTIPLIERS) as EmotionalValence[];
  const emotion = `(CASE COALESCE(emotional_valence, 'neutral') ${valences
    .map((v) => `WHEN '${v}' THEN ${num(applyLossAversionRatio(v, EMOTIONAL_MULTIPLIERS[v]))}`)
    .join(' ')} ELSE 1.0 END)`;
  const penalty = `pow(${DECAY_BASE}, MIN(${wrong}, ${MAX_WRONG_HALVINGS}))`;
  return `(CASE WHEN pinned THEN ${penalty} WHEN ${halfLife} <= 0 THEN 0.0
    ELSE MIN(1.0, MAX(0.0, ${decay} * ${boost} * ${emotion})) * ${penalty} END)`;
}

const sqlText = (s: string): string => `'${s.replace(/'/g, "''")}'`;
// json_each matches the tag as a whole element; substr, not LIKE, keeps the prefix case-sensitive like startsWith.
const keepPairSql = (p: KeepPair): string =>
  `(COALESCE(superseded_by, '') = '' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN tags_json ELSE '[]' END) WHERE value = ${sqlText(p.tag)}) AND substr(source, 1, ${p.sourcePrefix.length}) = ${sqlText(p.sourcePrefix)})`;

// Pinned and kept rows stay (a superseded row is not kept: its successor carries the tag and source); raw rows leave only through archiveRawMemory. The SQL twin guards the DELETE itself.
export const AUTO_DELETABLE_SQL = `pinned = 0 AND kind != 'raw'${KEEP_PAIRS.map((p) => ` AND NOT ${keepPairSql(p)}`).join('')}`;
