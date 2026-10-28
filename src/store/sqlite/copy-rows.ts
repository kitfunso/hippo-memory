// The rows that may hold one of a batch of texts word for word, spacing aside: phrase hits or the
// tenant's rows kept by mayHoldCopy's SQL twin; a text with a marker is matched in stored form.
import { chunked } from '../../base/util/chunked.js';
import { DEFAULT_TENANT_ID, type TenantId } from '../../base/util/tenant.js';
import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../db/index.js';
import type { SqlFragment } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { EntryFilter } from '../../base/ports/store/reports.js';
import type { EntryTextKey } from '../../base/ports/store/sharing.js';
import { bareText, mayHoldCopy } from '../rules/copies.js';
import { narrowingAnd } from './entry-filter.js';
import { bareTextSql } from './rule-sql.js';
import { tenantAnd, TENANT_IS } from './tenant.js';
import { spacedText } from '../../base/util/same-text.js';
import { redactSecretsStrict } from '../../base/util/secret-detect.js';

const REDACTED = '[REDACTED]';

// Letters and digits in every Unicode table unicode61 has shipped (Latin, Greek, Cyrillic, Hebrew,
// Arabic, Devanagari, Thai, kana, CJK, Hangul), so a phrase holding one names at least one token.
const SURE_TOKEN_CHAR = new RegExp(
  '[0-9A-Za-zÀ-ÖØ-öø-ſΑ-ΡΣ-Ωα-ωА-яא-תء-غف-يअ-हก-ะぁ-んァ-ヶ一-龥가-힣]',
);
const PHRASE_WORDS = 32;

/** The first words of `text`, which a row holding the text word for word holds in a row; null
 * when they might name no token, since an empty phrase matches no row. */
function openingPhrase(text: string): string | null {
  const opening = spacedText(text).split(' ').slice(0, PHRASE_WORDS).join(' ');
  return SURE_TOKEN_CHAR.test(opening) ? opening : null;
}

const IN_PHRASE_HITS = 'id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

/** The index query for `text`'s first words; null when the phrase might name no token. */
function holdingPhrase(text: string): string | null {
  const opening = openingPhrase(text);
  return opening === null ? null : `content : "${opening.replaceAll('"', '""')}"`;
}

// mayHoldCopy over `memories` columns; binds the JSON list of bare texts twice.
const MAY_HOLD_COPY_SQL =
  `(${bareTextSql('content')} IN (SELECT value FROM json_each(?)) OR (source = 'consolidation' AND ` +
  `EXISTS (SELECT 1 FROM json_each(?) WHERE instr(${bareTextSql('content')}, value) > 0)))`;

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export type CopyDbRow = {
  id: string;
  tenant_id: string | null;
  content: string;
  source: string;
  origin_project: string | null;
};

/** Which rows of the tenant a copy read looks at: `filter` adds predicates, each written ` AND
 * ...`. */
export interface CopyRead {
  readonly tenantId: TenantId;
  readonly filter: SqlFragment;
}

function copyChunk(
  db: DatabaseSyncLike,
  read: CopyRead,
  texts: readonly string[],
  phrases?: readonly string[],
): CopyDbRow[] {
  const tenant = tenantAnd(read.tenantId, phrases ? TENANT_IS : 'tenant_id = ?');
  const bares = JSON.stringify([...new Set(texts.map(bareText))]);
  return cachedStatement(
    db,
    `SELECT id, tenant_id, content, source, origin_project FROM memories WHERE ${phrases ? IN_PHRASE_HITS : '1'}` +
      `${tenant.sql}${read.filter.sql} AND ${MAY_HOLD_COPY_SQL}`,
  ).all(
    ...(phrases ? [phrases.join(' OR ')] : []),
    ...tenant.params,
    ...read.filter.params,
    bares,
    bares,
  ) as CopyDbRow[];
}

interface MarkerFreeProbe {
  readonly run: string;
  readonly words: string;
}

/** The longest run of `stored` between markers, and an index phrase of its whole words; a raw twin
 * holds both, since redaction rewrites only the marked spans. */
function markerFreeProbe(stored: string): MarkerFreeProbe {
  const segments = stored.split(REDACTED);
  const at = segments.reduce(
    (best, seg, i) => (bareText(seg).length > bareText(segments[best]).length ? i : best),
    0,
  );
  const words = spacedText(segments[at]).split(' ');
  const whole = words.slice(at > 0 ? 1 : 0, at < segments.length - 1 ? -1 : undefined);
  return { run: bareText(segments[at]), words: whole.join(' ') };
}

/** The rows `read` admits whose stored form may hold `stored`, a raw older twin included. */
function storedCopies(
  db: DatabaseSyncLike,
  read: CopyRead,
  stored: string,
  indexed: boolean,
): CopyDbRow[] {
  const { run, words } = markerFreeProbe(stored);
  const phrase = indexed ? holdingPhrase(words) : null;
  const tenant = tenantAnd(read.tenantId, phrase ? TENANT_IS : 'tenant_id = ?');
  const rows = cachedStatement(
    db,
    `SELECT id, tenant_id, content, source, origin_project FROM memories WHERE ${phrase ? IN_PHRASE_HITS : '1'}` +
      `${tenant.sql}${read.filter.sql} AND instr(${bareTextSql('content')}, ?) > 0`,
  ).all(...(phrase ? [phrase] : []), ...tenant.params, ...read.filter.params, run) as CopyDbRow[];
  const bares = new Set([bareText(stored)]);
  return rows.filter((row) =>
    mayHoldCopy({ content: redactSecretsStrict(row.content), source: row.source }, bares),
  );
}

/** The rows `read` admits that may hold one of `texts`, a raw older row included: a text whose stored
 * form holds a marker is matched in stored form, the rest word for word through the index first. */
export function rowsHoldingTexts(
  db: DatabaseSyncLike,
  read: CopyRead,
  texts: readonly string[],
): CopyDbRow[] {
  const indexed = isFtsAvailable(db) && isFtsInSync(db);
  const stored = [...new Set(texts.map(redactSecretsStrict))];
  const marked = stored.filter((text) => text.includes(REDACTED));
  const phraseOf = new Map(
    stored
      .filter((text) => !text.includes(REDACTED))
      .map((text) => [text, indexed ? holdingPhrase(text) : null]),
  );
  const named = [...phraseOf].filter((pair): pair is [string, string] => pair[1] !== null);
  const unnamed = [...phraseOf].filter(([, phrase]) => phrase === null).map(([text]) => text);
  const rows: CopyDbRow[] = [];
  for (const chunk of chunked(named)) {
    rows.push(
      ...copyChunk(
        db,
        read,
        chunk.map(([text]) => text),
        chunk.map(([, phrase]) => phrase),
      ),
    );
  }
  for (const chunk of chunked(unnamed)) rows.push(...copyChunk(db, read, chunk));
  for (const text of marked) rows.push(...storedCopies(db, read, text, indexed));
  return rows;
}

/** Each row `read` admits that may hold one of `texts`, once. */
function distinctRowsHolding(
  db: DatabaseSyncLike,
  read: CopyRead,
  texts: readonly string[],
): CopyDbRow[] {
  return [...new Map(rowsHoldingTexts(db, read, texts).map((row) => [row.id, row])).values()];
}

/** The rows `filter` keeps that may hold one of `texts` word for word, spacing aside. Callers
 * check each again. */
export function listTextKeysHolding(
  db: DatabaseSyncLike,
  filter: EntryFilter,
  texts: readonly string[],
): EntryTextKey[] {
  const { tenantId, ...narrowing } = filter;
  return distinctRowsHolding(db, { tenantId, filter: narrowingAnd(narrowing) }, texts).map(
    (row) => ({
      id: row.id,
      tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
      content: row.content,
      source: row.source,
    }),
  );
}
