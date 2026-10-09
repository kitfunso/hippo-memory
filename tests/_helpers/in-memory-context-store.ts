// A store other than hippo.db for the ContextReads group: it copies the rows getContext reads out of hippo.db, then answers
// each read from memory with the rules hippo-memory/server exports, so a test shows another store can match hippo.db's SQL.
import { listAuditEventsAfter } from '../../src/store/audit.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { rowToSessionHandoff, type SessionHandoffRow } from '../../src/handoff.js';
import {
  ftsTermParts, passesScopeFilterForRecall, rarestFtsQuery, SECRET_TAGS, tallyAmbientEntries, withSqliteAllowed,
  type AmbientCandidateRequest, type AmbientLoadResult, type AuditEvent, type ContextReads, type ContinuityKey, type HippoStore,
  type MemoryEntry, type RecentOrigins, type SessionHandoff, type VectorReads,
} from '../../src/server.js';
import { HANDOFF_COLUMNS } from '../../src/store/handoffs.js';
import { MEMORY_SELECT_COLUMNS, rowToEntry, type MemoryRow } from '../../src/store/rows.js';
import { assertTenantId } from '../../src/tenant.js';
import { inMemoryVectorStore } from './in-memory-vector-store.js';
import type { StoreSide } from './store-conformance.js';

export interface InMemoryContextStore extends StoreSide {
  readonly store: HippoStore & { readonly contextReads: ContextReads; readonly vectors: VectorReads };
  /** The name of each store read getContext made, the vector reads included, in call order. */
  readonly calls: readonly string[];
}

interface Keyed {
  readonly tenant_id: string;
  readonly owner_subject: string | null;
  readonly origin_project: string | null;
}

interface CopiedRows {
  readonly memories: readonly MemoryRow[];
  readonly handoffs: readonly (SessionHandoffRow & Keyed)[];
  /** How many full-text rows hold each lowercased term, every tenant counted, as the fts5vocab 'row' table reports. */
  readonly docCounts: ReadonlyMap<string, number>;
}

// unicode61 also strips diacritics, which none of the fixture's text carries.
function countDocs(fts: readonly { content: string | null; tags: string | null }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { content, tags } of fts) {
    for (const term of new Set(ftsTermParts(`${content ?? ''} ${tags ?? ''}`.toLowerCase()))) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function copyRows(hippoRoot: string): CopiedRows {
  return withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      // SAFETY: each SELECT below names its row type's columns, plus the tenant and key columns the type adds.
      const memories = db.prepare(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`).all() as MemoryRow[];
      // SAFETY: as above.
      const handoffs = db.prepare(`SELECT ${HANDOFF_COLUMNS}, tenant_id, owner_subject, origin_project FROM session_handoffs`).all() as (SessionHandoffRow & Keyed)[];
      // SAFETY: as above.
      const fts = db.prepare('SELECT content, tags FROM memories_fts').all() as { content: string | null; tags: string | null }[];
      return { memories, handoffs, docCounts: countDocs(fts) };
    } finally {
      closeHippoDb(db);
    }
  });
}

// SQLite orders TEXT by its UTF-8 bytes, which localeCompare does not.
const bytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** julianday's reading of the date forms the fixture writes: a zoneless one is UTC. */
function sqliteMs(text: string | null): number | null {
  if (text === null) return null;
  const iso = text.replace(' ', 'T');
  const ms = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function ownedBy(row: Keyed, key: ContinuityKey | null): boolean {
  if (key === null) return true;
  const names = key.project.filter((n) => n !== '');
  return key.owner !== '' && row.owner_subject === key.owner && row.origin_project !== null && names.includes(row.origin_project);
}

function newestHandoff(rows: readonly (SessionHandoffRow & Keyed)[]): SessionHandoff | null {
  const row = [...rows].sort((a, b) => bytes(b.created_at, a.created_at) || b.id - a.id)[0];
  return row ? rowToSessionHandoff(row) : null;
}

interface Envelope {
  readonly exactScope?: string;
  readonly ownScope?: string;
  readonly project?: readonly string[];
}

function inEnvelope(row: MemoryRow, tenantId: string, filter: Envelope): boolean {
  if (row.tenant_id !== tenantId || (row.superseded_by ?? '') !== '') return false;
  const scoped = filter.exactScope ? row.scope === filter.exactScope : passesScopeFilterForRecall(row.scope, undefined, filter.ownScope);
  if (!scoped) return false;
  const origin = row.origin_project;
  return filter.project === undefined || (origin !== null && (origin === '' || filter.project.includes(origin)));
}

/** loadContextCandidates' rank key: decay worn so far with the reward factor, null for a row with no half life. */
function decayKey(row: MemoryRow, nowMs: number): number | null {
  const last = sqliteMs(row.last_retrieved);
  if (!(row.half_life_days > 0) || last === null) return null;
  const pos = row.outcome_positive ?? 0;
  const neg = row.outcome_negative ?? 0;
  return (nowMs - last) / 86_400_000 / (row.half_life_days * (1 + (0.5 * (pos - neg)) / (pos + neg + 1)));
}

const nullsLast = (a: number | null, b: number | null): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

function secretAdmitted(row: MemoryRow, currentProject: readonly string[]): boolean {
  const origin = row.origin_project;
  if (origin !== null && origin !== '' && currentProject.includes(origin)) return true;
  return !rowToEntry(row).tags.some((t) => SECRET_TAGS.has(t.toLowerCase()));
}

// tallyAmbientEntries parses dates with Date, which reads a zoneless one as local time where julianday reads UTC.
function utcDates(e: MemoryEntry): MemoryEntry {
  const iso = (t: string): string => {
    const ms = sqliteMs(t);
    return ms === null ? t : new Date(ms).toISOString();
  };
  return { ...e, created: iso(e.created), last_retrieved: iso(e.last_retrieved) };
}

function inOrigins(e: MemoryEntry, origins: RecentOrigins): boolean {
  const origin = e.origin_project ?? null;
  return origin === '' ? origins.userGlobal : origin !== null && origins.names.includes(origin);
}

/** loadAmbientCandidates' recent rows: the same windows, read in the same order, so `admit` sees the same rows. */
function recentRows(live: readonly MemoryRow[], needed: number, admit: (e: MemoryEntry) => boolean, origins?: RecentOrigins): MemoryEntry[] {
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  const newest = [...live].sort((a, b) => bytes(b.created, a.created) || bytes(b.id, a.id));
  // The SQL origin filter differs from inOrigins: a '' name in the list admits '' rows even without userGlobal.
  const own = origins
    ? newest.filter((r) => r.origin_project !== null && ((origins.userGlobal && r.origin_project === '') || origins.names.includes(r.origin_project)))
    : newest;
  const window = Math.max(needed * 4, 32);
  const drifted = live.some((r) => [...r.created].length !== 24 || !/z$/i.test(r.created));
  if (!drifted) {
    const windowed = newest.slice(0, window).map(rowToEntry);
    const kept = windowed.filter(keep);
    if (kept.length >= needed || windowed.length < window) return kept;
    if (origins) {
      const ownWindow = own.slice(0, window).map(rowToEntry);
      const ownKept = ownWindow.filter(keep);
      if (ownKept.length >= needed || ownWindow.length < window) return ownKept;
    }
  }
  return own.map(rowToEntry).filter(keep);
}

export function inMemoryContextStore(hippoRoot: string): InMemoryContextStore {
  const { store: base, calls } = withSqliteAllowed(() => inMemoryVectorStore(hippoRoot));
  let rows = copyRows(hippoRoot);
  const logged = <A extends unknown[], R>(name: string, fn: (...args: A) => R) => (...args: A): R => {
    calls.push(name);
    return fn(...args);
  };

  async function ambientCandidates(tenantId: string, { recentNeeded, admit, recall, origins }: AmbientCandidateRequest): Promise<AmbientLoadResult> {
    const needed = Math.trunc(recentNeeded);
    const live = rows.memories.filter((r) => r.superseded_by === null && r.tenant_id === tenantId);
    const byId = new Map<string, MemoryEntry>();
    const pins = live.filter((r) => r.pinned === 1).sort((a, b) => bytes(a.created, b.created) || bytes(a.id, b.id)).map(rowToEntry);
    for (const e of pins) if (admit(e)) byId.set(e.id, e);
    if (needed > 0) for (const e of recentRows(live, needed, admit, origins)) byId.set(e.id, e);
    const entries = [...byId.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    if (!recall) return { entries };
    const query = rarestFtsQuery(recall.terms, (part) => rows.docCounts.get(part) ?? 0);
    const found = query
      ? await base.searchRecallEntries(query, {
          limit: recall.limit, tenantId, requestedScope: undefined, explicitScopeMode: 'exact', includeSuperseded: false, originProjects: undefined, ownScope: recall.ownScope,
        })
      : [];
    return { entries, recall: found };
  }

  const reads: ContextReads = {
    async unfinishedHandoff(tenantId, maxAgeMs, key) {
      assertTenantId('loadLatestHandoff', tenantId);
      const mine = rows.handoffs.filter((r) => r.tenant_id === tenantId && ownedBy(r, key));
      const newestId = new Map<string, number>();
      for (const r of mine) newestId.set(r.session_id, Math.max(newestId.get(r.session_id) ?? 0, r.id));
      const since = new Date(Date.now() - maxAgeMs).toISOString();
      return newestHandoff(mine.filter((r) => newestId.get(r.session_id) === r.id
        && (r.outcome === null || r.outcome === 'partial' || r.outcome === 'failure')
        && bytes(r.created_at, since) >= 0
        && passesScopeFilterForRecall(r.scope, undefined)));
    },
    ambientCandidates,
    async contextCandidates(tenantId, filter) {
      const nowMs = filter.now.getTime();
      const ranked = rows.memories
        .filter((r) => inEnvelope(r, tenantId, filter))
        .map((row) => ({ row, key: decayKey(row, nowMs) }))
        .sort((a, b) => b.row.pinned - a.row.pinned || nullsLast(a.key, b.key) || bytes(a.row.id, b.row.id));
      return ranked
        .slice(0, Math.max(0, Math.trunc(filter.cap)))
        .map(({ row }) => row)
        .sort((a, b) => bytes(a.created, b.created) || bytes(a.id, b.id))
        .map(rowToEntry);
    },
    async ambientTallies(tenantId, filter) {
      const kept = rows.memories.filter((r) => inEnvelope(r, tenantId, filter) && (r.kind ?? '') !== 'archived' && secretAdmitted(r, filter.currentProject));
      return tallyAmbientEntries(kept.map((r) => utcDates(rowToEntry(r))), filter.now);
    },
  };

  const store: InMemoryContextStore['store'] = {
    ...base,
    continuity: logged('continuity', base.continuity),
    searchRecallEntries: logged('searchRecallEntries', base.searchRecallEntries),
    // The strengthen lands in hippo.db through the base method, so the copy is taken again for the next read.
    async finishRecall(writes) {
      await base.finishRecall(writes);
      rows = copyRows(hippoRoot);
    },
    contextReads: {
      unfinishedHandoff: logged('unfinishedHandoff', reads.unfinishedHandoff),
      ambientCandidates: logged('ambientCandidates', reads.ambientCandidates),
      contextCandidates: logged('contextCandidates', reads.contextCandidates),
      ambientTallies: logged('ambientTallies', reads.ambientTallies),
    },
  };
  const auditRows = (): readonly AuditEvent[] => withSqliteAllowed(() => {
    const db = openHippoDb(hippoRoot);
    try {
      return listAuditEventsAfter(db, { afterId: 0, limit: 10_000 });
    } finally {
      closeHippoDb(db);
    }
  });
  return { store, auditRows, calls };
}
