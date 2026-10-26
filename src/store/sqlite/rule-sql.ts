// The SQL twins of the model's rules in src/base: strength.ts, keep-rules.ts, recall scope (recall-scope.ts), and
// the bare text of src/store/rules/copies.ts. Each is held equal to its JS half over seeded rows by a test: strength in
// tests/core/memory.test.ts and tests/store/rule-sql-parity.test.ts, keep in tests/core/keep-rule.test.ts, scope in
// tests/db/scope-admit-parity.test.ts and tests/api/personal-read-sites.process.test.ts, bare text in
// tests/store/rule-sql-parity.test.ts.
import { DAY_MS } from '../../base/util/time.js';
import {
  EMOTIONAL_MULTIPLIERS,
  FALLBACK_HALF_LIFE_DAYS,
  applyLossAversionRatio,
  type StrengthModel,
} from '../../base/memory/strength.js';
import { KEEP_PAIRS, type KeepPair } from '../../base/memory/keep-rules.js';
import type { EmotionalValence } from '../../base/memory/entry.js';
import { PERSONAL_SCOPE_PREFIX, RECALL_DEFAULT_DENY_SCOPES } from '../../base/scope/recall-scope.js';
import { placeholders, type SqlFragment } from '../../db/sql.js';
import { rewardFactorAt } from '../../db/decay-key.js';
import { SPACE_CODES } from '../rules/copies.js';

const UNIX_EPOCH_JULIAN_DAY = 2440587.5;

/** `bareText` over a column: every code point JavaScript's \s matches removed, as SPACE_CODES lists them. */
export const bareTextSql = (column: string): string =>
  SPACE_CODES.reduce((sql, code) => `replace(${sql}, char(${code}), '')`, column);

/** calculateRewardFactor as SQL over `memories` columns; strengthSql and the context-candidate rank both build on it,
 * so the slope has one source. */
export function rewardFactorSql(model: StrengthModel): string {
  return rewardFactorAt(model.rewardSlope);
}

/** calculateStrength's clock-basis formula under `model` as SQL over `memories` columns; keep in
 * step. An unparseable date scores NULL here and 0 in JS, so sums agree. `now` is bound, so the text, and the statement
 * cached for it, stay the same at every call. */
export function strengthSql(now: Date, model: StrengthModel): SqlFragment {
  return {
    sql: strengthSqlAt('?', model),
    params: model.decays ? [now.getTime() / DAY_MS + UNIX_EPOCH_JULIAN_DAY] : [],
  };
}

/** strengthSql with the current time as the Julian day `julianNow` names, for a statement that binds by name. */
export function strengthSqlAt(julianNow: string, model: StrengthModel): string {
  const num = (n: number): string => (Number.isInteger(n) ? n.toFixed(1) : String(n));
  const pos = 'COALESCE(outcome_positive, 0)';
  const neg = 'COALESCE(outcome_negative, 0)';
  const wrong = `MIN(MAX(0, ${neg} - ${pos}), ${model.maxWrongHalvings})`;
  const halfLife = `(COALESCE(half_life_days, ${FALLBACK_HALF_LIFE_DAYS}) * ${rewardFactorSql(model)})`;
  const anchor = model.recallStrengthens ? 'last_retrieved' : 'created';
  const decay = model.decays ? `pow(${model.decayBase}, (${julianNow} - julianday(${anchor})) / ${halfLife})` : '1.0';
  const boost = model.recallStrengthens
    ? `(CASE WHEN ${wrong} > 0 THEN 1.0 ELSE 1.0 + ${model.retrievalBoostSlope} * ` +
      `log2(COALESCE(retrieval_count, 0) + 1) END)`
    : '1.0';
  const valences = /* SAFETY: a Record keyed by EmotionalValence */ Object.keys(
    EMOTIONAL_MULTIPLIERS,
  ) as EmotionalValence[];
  const emotion = `(CASE COALESCE(emotional_valence, 'neutral') ${valences
    .map((v) => `WHEN '${v}' THEN ${num(applyLossAversionRatio(v, EMOTIONAL_MULTIPLIERS[v], model.lossAversionRatio))}`)
    .join(' ')} ELSE 1.0 END)`;
  const penalty = `pow(${model.decayBase}, ${wrong})`;
  return `(CASE WHEN pinned THEN ${penalty} WHEN ${halfLife} <= 0 THEN 0.0
    ELSE MIN(1.0, MAX(0.0, ${decay} * ${boost} * ${emotion})) * ${penalty} END)`;
}

/** The Julian day of the epoch milliseconds a statement binds as `msParam`, as strengthSqlAt reads the time. */
export const julianDayOfMs = (msParam: string): string => `(${msParam} / ${DAY_MS}.0 + ${UNIX_EPOCH_JULIAN_DAY})`;

// json_each matches the tag as a whole element; substr, not LIKE, keeps the prefix case-sensitive like startsWith.
const keepPairSql = (p: KeepPair): SqlFragment => ({
  sql:
    `(COALESCE(superseded_by, '') = '' AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(tags_json) THEN ` +
    `tags_json ELSE '[]' END) WHERE value = ?) AND substr(source, 1, ${p.sourcePrefix.length}) = ?)`,
  params: [p.tag, p.sourcePrefix],
});
const KEEP_PAIR_SQL = KEEP_PAIRS.map(keepPairSql);

// Pinned and kept rows stay (a superseded row is not kept: its successor carries the tag and source); raw rows leave
// only through archiveRawMemory. The SQL twin guards the DELETE itself.
export const AUTO_DELETABLE: SqlFragment = {
  sql: `pinned = 0 AND kind != 'raw'${KEEP_PAIR_SQL.map((k) => ` AND NOT ${k.sql}`).join('')}`,
  params: KEEP_PAIR_SQL.flatMap((k) => k.params),
};

/** SQL twin of the no-request arm of passesScopeFilterForRecall; `ownScope` is bound and compared with `=`, so `%` or
 * `_` in an owner match nothing extra. */
export function scopeAdmitSql(col: '' | 'm.', ownScope?: string | null): SqlFragment {
  const marks = placeholders(RECALL_DEFAULT_DENY_SCOPES.length);
  const admitted = `${col}scope IS NULL OR (${col}scope NOT IN (${marks}) AND ${col}scope NOT LIKE '%:private:%')`;
  if (ownScope == null) return { sql: `(${admitted})`, params: [...RECALL_DEFAULT_DENY_SCOPES] };
  // The own arm sits inside the outer parentheses so a caller's `AND ${sql}` cannot split it off.
  return { sql: `(${admitted} OR ${col}scope = ?)`, params: [...RECALL_DEFAULT_DENY_SCOPES, ownScope] };
}

/** `origin_project IN (?, ...)` with one placeholder per name, the SQL twin of an origin filter; an empty list matches
 * nothing. */
export function originInSql(names: readonly string[], column = 'origin_project'): string {
  return names.length === 0 ? '0' : `${column} IN (${placeholders(names.length)})`;
}

/** SQL twin of ownScopeTouches, which is also canReadScope for an admin: every row but another person's personal one.
 * LIKE folds ASCII case as isPersonalScope's /i does. */
export function touchableScopeSql(col: '' | 'm.', ownScope?: string | null): SqlFragment {
  const notPersonal = `${col}scope IS NULL OR ${col}scope NOT LIKE '${PERSONAL_SCOPE_PREFIX}%'`;
  if (ownScope == null) return { sql: `(${notPersonal})`, params: [] };
  return { sql: `(${notPersonal} OR ${col}scope = ?)`, params: [ownScope] };
}

/** Admits every scope, for a reader that sees the whole store, such as the CLI on its own machine. */
export const EVERY_SCOPE: SqlFragment = Object.freeze({ sql: '1', params: [] });
