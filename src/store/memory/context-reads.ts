// The in-memory ContextReads group: contextGet's fallback handoff, candidate rows and ambient tallies, read with the
// same windows and order hippo.db's SQL reads them in.
import { tallyAmbientEntries } from '../../base/memory/ambient.js';
import { isoInstant } from '../../base/memory/created-stamp.js';
import { computeSchemaFit, type MemoryEntry } from '../../base/memory/memory.js';
import { rarestFtsQuery } from '../../base/rank/prompt-recall.js';
import { ambientRefusal } from '../../base/scope/read-admission.js';
import { passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import { assertTenantId } from '../../base/scope/tenant-id.js';
import { SECRET_TAGS } from '../../base/util/secret-detect.js';
import { DAY_MS } from '../../base/util/time.js';
import type {
  AmbientCandidateRequest,
  AmbientCandidates,
  AmbientRefusal,
  ContextCandidateFilter,
  ContextReads,
  RecentOrigins,
} from '../port/context-reads.js';
import { latestHandoffIn } from './handoffs.js';
import { byBytes, oldestFirst } from './rows.js';
import { rowTerms } from './fts.js';
import { searchRecallIn } from './search.js';
import type { MemoryTables } from './tables.js';

/** schemaFit's window: the tenant's newest rows that move the fit. */
const SCHEMA_FIT_WINDOW_ROWS = 2000;

/** julianday's reading of a stamp: a zoneless one is UTC. */
function sqliteMs(text: string | null): number | null {
  if (text === null) return null;
  const iso = text.replace(' ', 'T');
  const ms = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : `${iso}Z`);
  return Number.isNaN(ms) ? null : ms;
}

const live = (e: MemoryEntry): boolean => (e.supersededBy ?? '') === '';

function inEnvelope(e: MemoryEntry, tenantId: string, filter: Omit<ContextCandidateFilter, 'cap' | 'now'>): boolean {
  if (e.tenantId !== tenantId || !live(e)) return false;
  const scoped = filter.exactScope
    ? e.scope === filter.exactScope
    : passesScopeFilterForRecall(e.scope ?? null, undefined, filter.ownScope);
  const origin = e.originProject ?? null;
  return (
    scoped && (filter.project === undefined || (origin !== null && (origin === '' || filter.project.includes(origin))))
  );
}

/** The context read's rank key: decay worn so far with the reward factor, null for a row with no half life. */
function decayKey(e: MemoryEntry, nowMs: number): number | null {
  const last = sqliteMs(e.lastRetrieved);
  if (!(e.halfLifeDays > 0) || last === null) return null;
  const pos = e.outcomePositive;
  const neg = e.outcomeNegative;
  return (nowMs - last) / DAY_MS / (e.halfLifeDays * (1 + (0.5 * (pos - neg)) / (pos + neg + 1)));
}

const nullsLast = (a: number | null, b: number | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

function contextCandidatesIn(t: MemoryTables, tenantId: string, filter: ContextCandidateFilter): MemoryEntry[] {
  const nowMs = filter.now.getTime();
  const ranked = [...t.entries.values()]
    .filter((e) => inEnvelope(e, tenantId, filter))
    .map((entry) => ({ entry, key: decayKey(entry, nowMs) }))
    .sort(
      (a, b) =>
        Number(b.entry.pinned) - Number(a.entry.pinned) || nullsLast(a.key, b.key) || byBytes(a.entry.id, b.entry.id),
    );
  const kept = ranked.slice(0, Math.max(0, Math.trunc(filter.cap))).map(({ entry }) => entry);
  return structuredClone(kept.sort(oldestFirst));
}

/** A secret-tagged row counts only inside its own non-empty origin project. */
function secretAdmitted(e: MemoryEntry, currentProject: readonly string[]): boolean {
  const origin = e.originProject ?? null;
  if (origin !== null && origin !== '' && currentProject.includes(origin)) return true;
  return !e.tags.some((tag) => SECRET_TAGS.has(tag.toLowerCase()));
}

// tallyAmbientEntries parses dates with Date, which reads a zoneless one as local time where julianday reads UTC.
function utcDates(e: MemoryEntry): MemoryEntry {
  const iso = (text: string): string => {
    const ms = sqliteMs(text);
    return ms === null ? text : new Date(ms).toISOString();
  };
  return { ...e, created: iso(e.created), lastRetrieved: iso(e.lastRetrieved) };
}

const inOrigins = (e: MemoryEntry, origins: RecentOrigins): boolean => {
  const origin = e.originProject ?? null;
  return origin === '' ? origins.userGlobal : origin !== null && origins.names.includes(origin);
};

/** The recent rows hippo.db reads: a window, then the caller's own projects' window, then keyset pages past it. */
function recentRows(
  rows: readonly MemoryEntry[],
  needed: number,
  admit: (e: MemoryEntry) => boolean,
  origins?: RecentOrigins,
) {
  const keep = origins ? (e: MemoryEntry): boolean => admit(e) && inOrigins(e, origins) : admit;
  // A drifted stamp sorts at the instant Date reads in it, an unreadable one last, as if written in toISOString form.
  const at = (e: MemoryEntry): string =>
    [...e.created].length === 24 && /z$/i.test(e.created) ? e.created : (isoInstant(e.created) ?? '');
  const newest = [...rows].sort((a, b) => byBytes(at(b), at(a)) || byBytes(b.id, a.id));
  // The SQL origin filter differs from inOrigins: a '' name in the list admits '' rows even without userGlobal.
  const own = origins
    ? newest.filter((e) => {
        const origin = e.originProject ?? null;
        return origin !== null && ((origins.userGlobal && origin === '') || origins.names.includes(origin));
      })
    : newest;
  const window = Math.max(needed * 4, 32);
  let kept = newest.slice(0, window).filter(keep);
  if (kept.length >= needed || newest.length < window) return kept;
  if (origins) {
    kept = own.slice(0, window).filter(keep);
    if (kept.length >= needed || own.length < window) return kept;
  }
  for (let start = window, size = window * 4; kept.length < needed; start += size, size *= 4) {
    const page = own.slice(start, start + size);
    kept = [...kept, ...page.filter(keep)];
    if (page.length < size) break;
  }
  return kept;
}

/** How many rows of every tenant hold each full-text term, as the fts5vocab 'row' table counts them. */
function docCounts(t: MemoryTables): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of t.entries.values()) {
    for (const term of rowTerms(e)) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
    }
  }
  return counts;
}

function ambientIn(t: MemoryTables, tenantId: string, request: AmbientCandidateRequest): AmbientCandidates {
  const refused: AmbientRefusal[] = [];
  const admit = (e: MemoryEntry): boolean => {
    const reason = ambientRefusal(e, request.admit);
    if (reason !== null) refused.push({ id: e.id, reason });
    return reason === null;
  };
  const needed = Math.trunc(request.recentNeeded);
  const rows = [...t.entries.values()].filter((e) => e.supersededBy === null && e.tenantId === tenantId);
  const byId = new Map<string, MemoryEntry>();
  for (const e of rows.filter((r) => r.pinned).sort(oldestFirst)) if (admit(e)) byId.set(e.id, e);
  if (needed > 0) for (const e of recentRows(rows, needed, admit, request.origins)) byId.set(e.id, e);
  // hippo.db sorts these in JavaScript with localeCompare, so this does too.
  const entries = structuredClone(
    [...byId.values()].sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id)),
  );
  const { recall } = request;
  if (!recall) return { entries, refused };
  const counts = docCounts(t);
  const query = rarestFtsQuery(recall.terms, (part) => counts.get(part) ?? 0);
  const args = { limit: recall.limit, tenantId, explicitScopeMode: 'exact', includeSuperseded: false } as const;
  const found = query ? searchRecallIn(t, query, { ...args, ownScope: recall.ownScope }) : [];
  return { entries, recall: found, refused };
}

/** The tenant's `limit` newest rows, oldest first; a negative limit is no limit, as SQLite's LIMIT reads it. */
function newestIn(t: MemoryTables, tenantId: string, limit: number): MemoryEntry[] {
  const newest = [...t.entries.values()]
    .filter((e) => e.tenantId === tenantId)
    .sort((a, b) => byBytes(b.created, a.created) || byBytes(b.id, a.id));
  return structuredClone((limit < 0 ? newest : newest.slice(0, limit)).reverse());
}

function liveContentsIn(t: MemoryTables, tenantId: string, source: string, tag: string, exceptSessionId: string) {
  const rows = [...t.entries.values()].filter(
    (e) =>
      e.tenantId === tenantId &&
      e.source === source &&
      (e.extractedFrom ?? '') === '' &&
      live(e) &&
      e.sourceSessionId !== exceptSessionId &&
      e.tags.includes(tag),
  );
  return rows.sort(oldestFirst).map((e) => e.content);
}

function rawRowsUnderRefIn(t: MemoryTables, tenantId: string, refPrefix: string) {
  const under = [...t.entries.values()].filter(
    (e): e is MemoryEntry & { artifactRef: string } =>
      e.tenantId === tenantId &&
      e.kind === 'raw' &&
      typeof e.artifactRef === 'string' &&
      e.artifactRef.startsWith(refPrefix),
  );
  return under.sort(oldestFirst).map((e) => ({
    id: e.id,
    artifact_ref: e.artifactRef,
    tags_json: JSON.stringify(e.tags),
    scope: e.scope ?? null,
  }));
}

export function memoryContextReads(t: MemoryTables): ContextReads {
  return {
    async unfinishedHandoff(tenantId, maxAgeMs, key) {
      assertTenantId('loadLatestHandoff', tenantId);
      return latestHandoffIn(t, tenantId, null, { unfinishedOnly: true, maxAgeMs, scopeFilter: 'default-deny' }, key);
    },
    ambientCandidates: async (tenantId, request) => ambientIn(t, tenantId, request),
    contextCandidates: async (tenantId, filter) => contextCandidatesIn(t, tenantId, filter),
    async ambientTallies(tenantId, filter) {
      const kept = [...t.entries.values()].filter(
        (e) => inEnvelope(e, tenantId, filter) && e.kind !== 'archived' && secretAdmitted(e, filter.currentProject),
      );
      return tallyAmbientEntries(kept.map(utcDates), filter.now);
    },
    newestEntries: async (tenantId, limit) => newestIn(t, tenantId, limit),
    schemaFit: async (tenantId, content, tags) =>
      computeSchemaFit(content, [...tags], newestIn(t, tenantId, SCHEMA_FIT_WINDOW_ROWS)),
    liveContentsBySourceAndTag: async (tenantId, source, tag, exceptSessionId) =>
      liveContentsIn(t, tenantId, source, tag, exceptSessionId),
    rawRowsUnderRef: async (tenantId, refPrefix) => rawRowsUnderRefIn(t, tenantId, refPrefix),
  };
}
