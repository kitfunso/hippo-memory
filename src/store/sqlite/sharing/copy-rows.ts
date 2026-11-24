import { chunked } from '../../../base/util/chunked.js';
import { DEFAULT_TENANT_ID, type TenantId } from '../../../base/util/tenant.js';
import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../../db/index.js';
import type { SqlFragment } from '../../../db/sql.js';
import { cachedStatement } from '../../../db/statement-cache.js';
import type { EntryFilter } from '../../../base/ports/store/reports.js';
import type { EntryTextKey } from '../../../base/ports/store/sharing.js';
import { bareText } from '../../rules/copies.js';
import { narrowingAnd } from '../entries/entry-filter.js';
import { ftsPhrase } from '../recall/fts-phrase.js';
import { bareTextSql, IDENTITY_TEXT_SQL } from '../runtime/rule-sql.js';
import { tenantAnd, TENANT_IS } from '../runtime/tenant.js';
import { duplicateKey, LEAD_IN_MARK } from '../../../base/util/same-text.js';

const SURE_TOKEN_CHAR = new RegExp(
  '[0-9A-Za-zÀ-ÖØ-öø-ſΑ-ΡΣ-Ωα-ωА-яא-תء-غف-يअ-हก-ะぁ-んァ-ヶ一-龥가-힣]',
);
const PHRASE_WORDS = 32;

function openingPhrase(text: string): string | null {
  const opening = duplicateKey(text.split(LEAD_IN_MARK)[0])
    .split(' ')
    .slice(0, PHRASE_WORDS)
    .join(' ');
  return SURE_TOKEN_CHAR.test(opening) ? opening : null;
}

const IN_PHRASE_HITS = 'id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

function holdingPhrase(text: string): string | null {
  const opening = openingPhrase(text);
  return opening === null ? null : `content : ${ftsPhrase(opening)}`;
}

const MAY_HOLD_COPY_SQL =
  `(${bareTextSql(IDENTITY_TEXT_SQL)} IN (SELECT value FROM json_each(?)) OR (source = 'consolidation' AND ` +
  `EXISTS (SELECT 1 FROM json_each(?) WHERE instr(${bareTextSql('content')}, value) > 0)))`;

// SAFETY: every read cast to this row selects all its keys; scripts/checks/check-row-casts.mjs proves it.
export type CopyDbRow = {
  id: string;
  tenant_id: string | null;
  content: string;
  lead_in: string | null;
  source: string;
  origin_project: string | null;
  pinned: number;
  tags_json: string | null;
  superseded_by: string | null;
  confidence: string;
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
    `SELECT id, tenant_id, content, lead_in, source, origin_project, pinned, tags_json, superseded_by, confidence ` +
      `FROM memories ` +
      `WHERE ${phrases ? IN_PHRASE_HITS : '1'}` +
      `${tenant.sql}${read.filter.sql} AND ${MAY_HOLD_COPY_SQL}`,
  ).all(
    ...(phrases ? [phrases.join(' OR ')] : []),
    ...tenant.params,
    ...read.filter.params,
    bares,
    bares,
  ) as CopyDbRow[];
}

/** The rows `read` admits that may hold one of `texts`, a superset of the copies heldTextKeys
 * finds: the texts the index can name first, a row once per chunk it matches. */
export function rowsHoldingTexts(
  db: DatabaseSyncLike,
  read: CopyRead,
  texts: readonly string[],
): CopyDbRow[] {
  const indexed = isFtsAvailable(db) && isFtsInSync(db);
  const phraseOf = new Map(
    [...new Set(texts)].map((text) => [text, indexed ? holdingPhrase(text) : null]),
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
  return rows;
}

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
      leadIn: row.lead_in,
      source: row.source,
    }),
  );
}
