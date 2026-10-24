// The rows that may hold one of a batch of texts word for word, spacing aside, one query per chunk: the index's phrase
// hits for the texts it can name, else the tenant's rows, each kept only by mayHoldCopy's SQL twin.
import { chunked } from '../../base/util/chunked.js';
import { DEFAULT_TENANT_ID, type TenantId } from '../../base/util/tenant.js';
import { isFtsAvailable, isFtsInSync, type DatabaseSyncLike } from '../../db/index.js';
import type { SqlFragment } from '../../db/sql.js';
import { cachedStatement } from '../../db/statement-cache.js';
import type { EntryTextKey } from '../port/sharing.js';
import { bareText, mayHoldCopy, SPACE_CODES } from '../rules/copies.js';
import { openingPhrase } from '../rules/fts.js';
import { originAnd, TENANT_IS } from './entry-reads.js';
import { tenantAnd } from './tenant.js';

const IN_PHRASE_HITS = 'id IN (SELECT id FROM memories_fts WHERE memories_fts MATCH ?)';

/** The index query for `text`'s first words; null when the phrase might name no token. */
function holdingPhrase(text: string): string | null {
  const opening = openingPhrase(text);
  return opening === null ? null : `content : "${opening.replaceAll('"', '""')}"`;
}

const bareSql = (column: string): string =>
  SPACE_CODES.reduce((sql, code) => `replace(${sql}, char(${code}), '')`, column);

// mayHoldCopy over `memories` columns; binds the JSON list of bare texts twice.
const MAY_HOLD_COPY_SQL =
  `(${bareSql('content')} IN (SELECT value FROM json_each(?)) OR (source = 'consolidation' AND ` +
  `EXISTS (SELECT 1 FROM json_each(?) WHERE instr(${bareSql('content')}, value) > 0)))`;

// SAFETY: every read cast to this row selects all its keys; scripts/check-row-casts.mjs proves it.
export type CopyDbRow = {
  id: string;
  tenant_id: string | null;
  content: string;
  source: string;
  origin_project: string | null;
};

/** Which rows of the tenant a copy read looks at: `filter` adds predicates, each written ` AND ...`. */
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

/** The rows `read` admits that may hold one of `texts`, a superset of the copies heldTextKeys finds: the texts the
 * index can name first, a row once per chunk it matches. */
export function rowsHoldingTexts(db: DatabaseSyncLike, read: CopyRead, texts: readonly string[]): CopyDbRow[] {
  const indexed = isFtsAvailable(db) && isFtsInSync(db);
  const phraseOf = new Map([...new Set(texts)].map((text) => [text, indexed ? holdingPhrase(text) : null]));
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

/** Each row `read` admits that may hold one of `texts`, once. */
function distinctRowsHolding(db: DatabaseSyncLike, read: CopyRead, texts: readonly string[]): CopyDbRow[] {
  return [...new Map(rowsHoldingTexts(db, read, texts).map((row) => [row.id, row])).values()];
}

const NO_FILTER: SqlFragment = { sql: '', params: [] };

/** The rows of `tenantId` that may hold one of `texts` word for word, spacing aside. Callers check each again. */
export function selectTextKeysHolding(
  db: DatabaseSyncLike,
  tenantId: TenantId,
  texts: readonly string[],
): EntryTextKey[] {
  return distinctRowsHolding(db, { tenantId, filter: NO_FILTER }, texts).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id ?? DEFAULT_TENANT_ID,
    content: row.content,
    source: row.source,
  }));
}

/** Per text, in order: the tenant's live rows whose source does not start with `sourcePrefix` that may hold it word for
 * word, spacing aside. `origins` (global store only) limits them to user-global rows and those projects. A superset:
 * the caller checks each again. */
export function selectRowsHoldingOutsideSourcePrefix(
  db: DatabaseSyncLike,
  tenantId: string,
  texts: readonly string[],
  sourcePrefix: string,
  origins: readonly string[] | null,
): Array<Array<{ id: string; content: string; source: string }>> {
  const visible = originAnd(origins);
  const filter = {
    sql: ` AND superseded_by IS NULL AND substr(source, 1, ?) != ?${visible.sql}`,
    params: [sourcePrefix.length, sourcePrefix, ...visible.params],
  };
  const rows = distinctRowsHolding(db, { tenantId, filter }, texts);
  return texts.map((text) => {
    const bare = new Set([bareText(text)]);
    return rows
      .filter((row) => mayHoldCopy(row, bare))
      .map((row) => ({ id: row.id, content: row.content, source: row.source }));
  });
}
