// A store that answers only through the port: the server blocks hippo.db for any other kind, so a recall
// path that still opens hippo.db directly throws, while the port's own methods reach the same rows.
import { withSqliteAllowed } from '../../src/db/index.js';
import type { HippoStore, OptionalGroup, StoreGroups } from '../../src/store/index.js';
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

// The optional groups, which an add-on store at its smallest has none of.
const LEFT_OUT: ReadonlySet<string> = new Set<OptionalGroup>([
  'vectorViews',
  'readiness',
  'lastRecall',
  ...FOLDER_GROUPS,
]);

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

/** hippo.db's required groups and none of the optional ones: an add-on store at its smallest. Base
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
