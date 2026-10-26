// A store that answers only through the port: the server blocks hippo.db for any other kind, so a recall
// path that still opens hippo.db directly throws, while the port's own methods reach the same rows.
import { closeHippoDb, openHippoDb, withSqliteAllowed } from '../../src/db/index.js';
import type { AuditEvent } from '../../src/base/ports/store/types.js';
import { auditRowsOn } from './audit-rows.js';
import {
  OPTIONAL_GROUPS,
  type HippoStore,
  type OptionalGroup,
  type StoreGroups,
  type StoreWith,
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

/** `store` without its folder groups, as a store that is not hippo.db holds none; copying string keys alone drops the
 * symbol that marks a store as hippo.db. */
export function withoutFolderGroups<S extends HippoStore>(store: S): Omit<S, FolderGroup> {
  const folder: ReadonlySet<string> = new Set(FOLDER_GROUPS);
  // SAFETY: the string-keyed members of `store` minus exactly the folder groups.
  return Object.fromEntries(Object.entries(store).filter(([key]) => !folder.has(key))) as Omit<S, FolderGroup>;
}

function allowed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => withSqliteAllowed(() => fn(...args));
}

function allowedGroup<T extends object>(group: T): T {
  // SAFETY: every member of a store group is a method, each swapped for a wrapper of the same signature.
  return Object.fromEntries(Object.entries(group).map(([name, method]) => [name, allowed(method)])) as T;
}

/** hippo.db's required groups and of the optional ones only `keep`: with none kept, an add-on store at its smallest.
 * Base methods are listed by hand so one added to the port fails to compile here until it is wired. */
export function portOnlyStore<G extends OptionalGroup = never>(
  hippoRoot: string,
  keep: readonly G[] = [],
): StoreWith<G> {
  const inner = sqliteStore(hippoRoot);
  const leftOut: ReadonlySet<string> = new Set<OptionalGroup>(
    OPTIONAL_GROUPS.filter((group) => !keep.some((k) => k === group)),
  );
  const base = {
    kind: 'port-only',
    findApiKey: allowed(inner.findApiKey),
    searchRecallEntries: allowed(inner.searchRecallEntries),
    entriesByIds: allowed(inner.entriesByIds),
    activeGoals: allowed(inner.activeGoals),
    freshRawEntries: allowed(inner.freshRawEntries),
    continuity: allowed(inner.continuity),
    planningFallacyEvidence: allowed(inner.planningFallacyEvidence),
    appendAuditEvents: allowed(inner.appendAuditEvents),
    finishRecall: allowed(inner.finishRecall),
    bumpRecallStats: allowed(inner.bumpRecallStats),
    bumpRemembered: allowed(inner.bumpRemembered),
    recordTokens: allowed(inner.recordTokens),
    close: allowed(inner.close),
  };
  const groups = Object.entries(inner).filter(([key]) => !(key in base) && !leftOut.has(key));
  // SAFETY: what is left of sqliteStore's own keys is its required groups and the kept ones, each wrapped whole.
  const kept = Object.fromEntries(groups.map(([key, group]) => [key, allowedGroup(group)])) as Omit<
    StoreGroups,
    OptionalGroup
  > &
    Pick<StoreGroups, G>;
  return { ...base, ...kept };
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
  const { contextReads: c, vectors: v, sessions } = store;
  return {
    ...store,
    continuity: log('continuity', store.continuity),
    searchRecallEntries: log('searchRecallEntries', store.searchRecallEntries),
    // SAFETY: log passes every argument through and returns read's own answer, so each overload still holds.
    sessions: { ...sessions, read: log('sessions.read', sessions.read) as HippoStore['sessions']['read'] },
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
    },
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
): PortOnlySide<G> {
  const calls: string[] = [];
  return {
    store: logged(portOnlyStore(hippoRoot, keep), calls),
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
