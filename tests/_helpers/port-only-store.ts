// A store that answers only through the port, under a kind that is not hippo.db, while the port's own methods reach
// hippo.db's rows.
import { closeHippoDb, openHippoDb, type RequestStores } from '../../src/db/index.js';
import type { AuditEvent } from '../../src/base/ports/store/types.js';
import { auditRowsOn } from './audit-rows.js';
import {
  hasGroup,
  OPTIONAL_GROUPS,
  type HippoStore,
  type OptionalGroup,
  type StoreGroups,
  type StoreWith,
  type Sessions,
} from '../../src/base/ports/store-index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

/** The groups only a store kept as files in a folder serves, which an add-on store holds none of. */
export const FOLDER_GROUPS = [
  'ledger',
  'embeddingIndex',
  'promotion',
  'folderFiles',
  'sharing',
  'consolidation',
  'learning',
  'captures',
  'compactionHooks',
  'projectTags',
  'diagnostics',
  'graphRebuild',
  'agentImport',
] as const satisfies readonly OptionalGroup[];
type FolderGroup = (typeof FOLDER_GROUPS)[number];

/** `store` without its folder groups or hippo.db's local tier, as a store that is not hippo.db holds neither; copying
 * string keys alone drops the symbol that marks a store as hippo.db. */
export function withoutFolderGroups<S extends HippoStore>(store: S): Omit<S, FolderGroup | 'hippoDb'> {
  const folder: ReadonlySet<string> = new Set([...FOLDER_GROUPS, 'hippoDb']);
  // SAFETY: the string-keyed members of `store` minus exactly the folder groups and the local tier.
  return Object.fromEntries(Object.entries(store).filter(([key]) => !folder.has(key))) as Omit<
    S,
    FolderGroup | 'hippoDb'
  >;
}

/** hippo.db's required groups and of the optional ones only `keep`: with none kept, an add-on store at its smallest.
 * Base methods are listed by hand so one added to the port fails to compile here until it is wired. A `session`
 * keeps one handle across calls, as an add-on store's own connection pool would. */
export function portOnlyStore<G extends OptionalGroup = never>(
  hippoRoot: string,
  keep: readonly G[] = [],
  session?: RequestStores,
): StoreWith<G> {
  const inner = sqliteStore(hippoRoot, { session });
  // hippo.db's local tier is no port group, so a store outside hippo.db holds none of it.
  const leftOut: ReadonlySet<string> = new Set<string>([
    'hippoDb',
    ...OPTIONAL_GROUPS.filter((group) => !keep.some((k) => k === group)),
  ]);
  const base = {
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
  };
  const groups = Object.entries(inner).filter(([key]) => !(key in base) && !leftOut.has(key));
  const local = Object.entries(inner.hippoDb).filter(([key]) => keep.some((k) => k === key));
  const kept = Object.fromEntries(groups);
  // SAFETY: sqliteStore's own string keys less the left-out groups are its required groups and the kept ones,
  // and the kept groups hippo.db serves from its local tier sit under `hippoDb`, as StoreWith<G> asks.
  return { ...base, ...kept, ...(local.length > 0 && { hippoDb: Object.fromEntries(local) }) } as StoreWith<G>;
}

/** The store with the name of each recall and context read it answers pushed onto `calls`: the two base reads,
 * contextReads, vectors and the sessions read. */
function logged<S extends HippoStore>(store: S, calls: string[]): S {
  const log =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      calls.push(name);
      return fn(...args);
    };
  const { contextReads: c, vectors: v } = store;
  const tier = hasGroup(store, 'sessions') ? store.hippoDb : undefined;
  return {
    ...store,
    continuity: log('continuity', store.continuity),
    searchRecallEntries: log('searchRecallEntries', store.searchRecallEntries),
    ...(tier && {
      hippoDb: {
        ...tier,
        // SAFETY: log passes every argument through and returns read's own answer, so each overload still holds.
        sessions: { ...tier.sessions, read: log('sessions.read', tier.sessions.read) as Sessions['read'] },
      },
    }),
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
    } satisfies StoreGroups['vectors'],
  };
}

/** A port-only store that logs its recall reads, and a read of every audit row it holds, oldest first. */
export interface PortOnlySide<G extends OptionalGroup = never> {
  readonly store: StoreWith<G>;
  readonly calls: readonly string[];
  readonly auditRows: () => AuditEvent[];
}

export function portOnlySide<G extends OptionalGroup = never>(
  hippoRoot: string,
  keep: readonly G[] = [],
  session?: RequestStores,
): PortOnlySide<G> {
  const calls: string[] = [];
  return {
    store: logged(portOnlyStore(hippoRoot, keep, session), calls),
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
