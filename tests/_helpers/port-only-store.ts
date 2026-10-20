// A store that answers only through the port: the server blocks hippo.db for any other kind, so a recall
// path that still opens hippo.db directly throws, while the port's own methods reach the same rows.
import { withSqliteAllowed } from '../../src/db/index.js';
import type { HippoStore, OptionalGroup, StoreGroups } from '../../src/store/index.js';
import type { LocalStore } from '../../src/store/local/index.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';

// The optional groups and the local files beside the port, which an add-on store at its smallest has none of.
const LEFT_OUT: ReadonlySet<string> = new Set<OptionalGroup | 'localFiles'>([
  'localFiles',
  'vectorViews',
  'readiness',
  'lastRecall',
]);

/** `store` without its local files, as a store that is not hippo.db holds none. */
export function withoutLocalFiles<S extends LocalStore>(store: S): Omit<S, 'localFiles'> {
  const { localFiles: _files, ...port } = store;
  return port;
}

function allowed<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args) => withSqliteAllowed(() => fn(...args));
}

function allowedGroup<T extends object>(group: T): T {
  // SAFETY: every member of a store group is a method, each swapped for a wrapper of the same signature.
  return Object.fromEntries(Object.entries(group).map(([name, method]) => [name, allowed(method)])) as T;
}

/** hippo.db's required groups and none of the optional ones, so no local files: an add-on store at its smallest. Base
 * methods are listed by hand so one added to the port fails to compile here until it is wired. */
export function portOnlyStore(hippoRoot: string): HippoStore {
  const inner = sqliteStore(hippoRoot);
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
    recordTokens: allowed(inner.recordTokens),
    close: allowed(inner.close),
  };
  const groups = Object.entries(inner).filter(([key]) => !(key in base) && !LEFT_OUT.has(key));
  // SAFETY: what is left of sqliteStore's own keys is its required groups, each wrapped whole.
  const required = Object.fromEntries(groups.map(([key, group]) => [key, allowedGroup(group)])) as Omit<
    StoreGroups,
    OptionalGroup
  >;
  return { ...base, ...required };
}
