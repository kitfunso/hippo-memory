// The in-memory LessonWrites group: git learn's text and tag reads and its batch writes.
import { CrossTenantIdError, RejectedValueError } from '../../base/errors/api-errors.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import { ownScopeTouches, passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import { errorFields, log } from '../../base/util/log.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { chunked } from '../../base/util/chunked.js';
import type { LessonWrites } from '../port/entry-writes.js';
import type { HeldText } from '../port/types.js';
import { bareText, mayHoldCopy } from '../rules/copies.js';
import { contentHoldsPhrase, openingPhrase } from '../rules/fts.js';
import { bumpCounter } from './rows.js';
import { put, refusalEvent, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

/** A row one of a batch's phrases hits that mayHoldCopy keeps, as hippo.db's copy read; a text with no phrase is
 * mayHoldCopy alone. */
function holdsBatch(entry: MemoryEntry, batch: readonly string[], bares: ReadonlySet<string>, phrased: boolean) {
  const hit = !phrased || batch.some((text) => contentHoldsPhrase(entry, openingPhrase(text)!));
  return hit && mayHoldCopy(entry, bares);
}

/** The tenant's rows that may hold one of `texts`, among rows the caller may touch. */
function textsHoldingIn(t: MemoryTables, tenantId: string, texts: readonly string[], ownScope: string | null) {
  const wanted = [...new Set(texts)];
  const rows = [...t.entries.values()].filter(
    (e) => e.tenantId === tenantId && ownScopeTouches(ownScope, e.scope ?? null),
  );
  const held = new Map<string, MemoryEntry>();
  const batches = [
    ...chunked(wanted.filter((w) => openingPhrase(w) !== null)).map((batch) => ({ batch, phrased: true })),
    ...chunked(wanted.filter((w) => openingPhrase(w) === null)).map((batch) => ({ batch, phrased: false })),
  ];
  for (const { batch, phrased } of batches) {
    const bares = new Set(batch.map(bareText));
    for (const e of rows) if (holdsBatch(e, batch, bares, phrased)) held.set(e.id, e);
  }
  return [...held.values()].map((e): HeldText => ({
    content: e.content,
    source: e.source,
    originProject: e.originProject ?? null,
  }));
}

/** Team-visible rows tagged exactly `tag`; with `origins`, those projects' rows and user-global ones. */
function contentsWithTagIn(t: MemoryTables, tenantId: string, tag: string, origins?: readonly string[]): string[] {
  const inOrigins = (origin: string | null): boolean =>
    origins === undefined || (origin !== null && (origin === '' || origins.includes(origin)));
  const tagged = [...t.entries.values()].filter(
    (e) =>
      e.tenantId === tenantId &&
      e.tags.includes(tag) &&
      inOrigins(e.originProject ?? null) &&
      passesScopeFilterForRecall(e.scope ?? null, undefined),
  );
  return tagged.map((e) => e.content);
}

/** One staged write; a refused value leaves its refusal row in order, a foreign id is skipped, the rest goes on. */
function writeSkippingIn(
  t: MemoryTables,
  entries: Parameters<LessonWrites['writeSkippingRejected']>[0],
  actor: string,
) {
  return stage(t, actor, (tx) =>
    entries.flatMap((entry) => {
      try {
        put(t, tx, entry, actor);
        return [entry.id];
      } catch (err) {
        if (err instanceof CrossTenantIdError) {
          log.warn(`${err.message}; row skipped`, errorFields(err));
          return [];
        }
        if (!(err instanceof RejectedValueError)) throw err;
        tx.audit.push(refusalEvent(err, actor));
        return [];
      }
    }),
  );
}

export function memoryLessonWrites(t: MemoryTables): LessonWrites {
  return {
    textsHolding: async (tenantId, texts, ownScope) => textsHoldingIn(t, tenantId, texts, ownScope),
    contentsWithTag: async (tenantId, tag, origins) => contentsWithTagIn(t, tenantId, tag, origins),
    writeSkippingRejected: async (entries, actor) => writeSkippingIn(t, entries, actor),
    async writeTogether(entries) {
      if (entries.length === 0) return;
      stage(t, CLI_ACTOR, (tx) => {
        for (const entry of entries) put(t, tx, entry, CLI_ACTOR);
      });
    },
    bumpRemembered: async (count) => bumpCounter(t, 'total_remembered', count),
  };
}
