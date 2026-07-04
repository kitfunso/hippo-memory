/**
 * v1.25.0 — recall-side scope predicates, extracted from api.ts into a leaf
 * module so shared.ts (which api.ts imports) can apply the same default-deny
 * rule to searchBothHybrid's internal candidate loads without an import
 * cycle. Mirrors the v39 `project-identity.ts` precedent. api.ts imports
 * these for its own call sites AND re-exports them for back-compat
 * (`api.isPrivateScope`, test imports of `passesScopeFilterForRecall`).
 */

import { RECALL_DEFAULT_DENY_SCOPES } from './store.js';

/**
 * v1.2.1: source-agnostic private-scope detector. A scope string is treated
 * as private when it has the shape `<lowercase-source>:private:<rest>`.
 *
 * Examples that match:
 *   slack:private:Cabc, github:private:owner/repo, jira:private:PROJ-1
 * Examples that DO NOT match:
 *   slack:public:Cgeneral, acme:public:my-private-channel, null, '',
 *   'unknown:legacy', 'private' (alone), 'private:foo' (no source prefix).
 *
 * Used by api.recall, mcp/server.ts (hippo_recall + hippo_context),
 * cli.ts (cmdRecall + cmdExplain + continuity), shared.ts (searchBothHybrid
 * recall mode). Keep these in sync — the export is the single source of
 * truth so connector work cannot drift.
 */
export const PRIVATE_SCOPE_RE = /^[a-z][a-z0-9_-]*:private:/;

/** True when `scope` matches the `<source>:private:*` shape. */
export function isPrivateScope(scope: string | null | undefined): boolean {
  return typeof scope === 'string' && PRIVATE_SCOPE_RE.test(scope);
}

/**
 * Recall-side scope filter — the canonical JS half of the recall default-deny
 * rule (the SQL half lives in `loadSearchRows` via `loadRecallSearchEntries`).
 *
 * - When `requested` is set and non-empty: exact match required.
 * - When `requested` is undefined/empty: default-deny on any
 *   `<source>:private:*` scope and on the `RECALL_DEFAULT_DENY_SCOPES`
 *   quarantine buckets. `null` and public scopes pass.
 *
 * @internal v1.7.2 — exported for test parity with
 * `RECALL_DEFAULT_DENY_SCOPES` (single-source-of-truth verification). NOT part
 * of the public API surface; not re-exported from `src/index.ts`. Subject to
 * change without semver bump.
 */
export function passesScopeFilterForRecall(
  scope: string | null,
  requested: string | undefined,
): boolean {
  if (requested !== undefined && requested !== '') {
    return scope === requested;
  }
  if (scope === null) return true;
  if (isPrivateScope(scope)) return false;
  // v1.7.2 — read from RECALL_DEFAULT_DENY_SCOPES (single source of truth
  // shared with the SQL clause in loadSearchRows). Cast the array to
  // readonly string[] so .includes() accepts arbitrary string scopes
  // without a cast on the input (codex P0-2: casting `scope` would defeat
  // the constant's safety).
  if ((RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(scope)) return false;
  return true;
}

/**
 * v1.25.0 — the CLI `--scope` variant of the recall filter (JS half of the
 * SQL 'default-deny-or-exact' mode in loadSearchRows).
 *
 * The CLI flag predates the envelope column as a TAG-boost ranking hint
 * (`scope:<v>` tags, HIPPO_SCOPE, detectScope()), so an explicit `--scope X`
 * UNLOCKS envelope scope X in addition to the default-admitted set — it does
 * NOT narrow the result to X (that would return zero rows for every
 * tag-scoped workflow, whose envelope scope is NULL). api.recall keeps the
 * narrowing 'exact' semantics via `passesScopeFilterForRecall`.
 */
export function passesCliRecallScopeFilter(
  scope: string | null,
  requested: string | undefined,
): boolean {
  if (requested !== undefined && requested !== '' && scope === requested) {
    return true;
  }
  return passesScopeFilterForRecall(scope, undefined);
}
