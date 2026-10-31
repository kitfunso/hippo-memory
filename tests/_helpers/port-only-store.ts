// A store that answers only through the port, under a kind that is not hippo.db, while the port's own methods reach
// hippo.db's rows.
import { closeHippoDb, openHippoDb, type RequestStores } from '../../src/db/index.js';
import type { AuditEvent } from '../../src/base/ports/store/types.js';
import { auditRowsOn } from './audit-rows.js';
import type { HippoStore, CoreGroups } from '../../src/base/ports/store-index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** `store` without hippo.db's local tier, as a store that is not hippo.db holds none of it; copying string keys alone
 * drops the symbol that marks a store as hippo.db. */
export function withoutHippoDb<S extends HippoStore>(store: S): Omit<S, 'hippoDb'> {
  // SAFETY: the string-keyed members of `store` minus exactly the local tier.
  return Object.fromEntries(Object.entries(store).filter(([key]) => key !== 'hippoDb')) as Omit<S, 'hippoDb'>;
}

/** hippo.db's core groups and base methods alone, under a kind that is not hippo.db: an add-on store at its smallest.
 * Base methods are listed by hand so one added to the port fails to compile here until it is wired. A `session`
 * keeps one handle across calls, as an add-on store's own connection pool would. */
export function portOnlyStore(hippoRoot: string, session?: RequestStores): HippoStore {
  const inner = sqliteStore(hippoRoot, { session });
  const { keyWrites, entryWrites, contextReads, auditLog, vectors, vectorWrites } = inner;
  return {
    kind: 'port-only',
    findApiKey: inner.findApiKey,
    searchRecallEntries: inner.searchRecallEntries,
    entriesByIds: inner.entriesByIds,
    entriesWhere: inner.entriesWhere,
    activeGoals: inner.activeGoals,
    freshRawEntries: inner.freshRawEntries,
    continuity: inner.continuity,
    planningFallacyEvidence: inner.planningFallacyEvidence,
    appendAuditEvents: inner.appendAuditEvents,
    finishRecall: inner.finishRecall,
    bumpRecallStats: inner.bumpRecallStats,
    recordTokens: inner.recordTokens,
    close: inner.close,
    keyWrites,
    entryWrites,
    contextReads,
    auditLog,
    vectors,
    vectorWrites,
  };
}

/** The store with the name of each recall and context read it answers pushed onto `calls`: the two base reads,
 * contextReads and vectors. */
function logged<S extends HippoStore>(store: S, calls: string[]): S {
  const log =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  const { contextReads: c, vectors: v } = store;
  return {
    ...store,
    continuity: log('continuity', store.continuity),
    searchRecallEntries: log('searchRecallEntries', store.searchRecallEntries),
    contextReads: {
      ambientCandidates: log('ambientCandidates', c.ambientCandidates),
      contextCandidates: log('contextCandidates', c.contextCandidates),
      ambientTallies: log('ambientTallies', c.ambientTallies),
      schemaFit: log('schemaFit', c.schemaFit),
    },
    vectors: {
      embeddingIndexState: log('embeddingIndexState', v.embeddingIndexState),
      stored: (part, ids) => {
        calls.push(`stored:${part}`);
        return v.stored(part, ids);
      },
      nearestEntries: log('nearestEntries', v.nearestEntries),
    } satisfies CoreGroups['vectors'],
  };
}

/** A port-only store that logs its recall reads, and a read of every audit row it holds, oldest first. */
export interface PortOnlySide {
  readonly store: HippoStore;
  readonly calls: readonly string[];
  readonly auditRows: () => AuditEvent[];
}

export function portOnlySide(hippoRoot: string, session?: RequestStores): PortOnlySide {
  const calls: string[] = [];
  return {
    store: logged(portOnlyStore(hippoRoot, session), calls),
    calls,
    auditRows: () => {
      const db = openHippoDb(hippoRoot);
      try {
        return auditRowsOn(db);
      } finally {
        closeHippoDb(db);
      }
    },
  };
}
