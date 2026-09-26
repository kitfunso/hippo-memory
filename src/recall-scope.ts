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

function isScopeString(value: string | null | undefined): value is string {
  return typeof value === 'string';
}

/** True when `scope` matches the `<source>:private:*` shape. */
export function isPrivateScope(scope: string | null | undefined): boolean {
  if (!isScopeString(scope)) return false;
  return PRIVATE_SCOPE_RE.test(scope);
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
  return !isRestrictedScope(scope);
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
 *
 * Note the unlock applies to whatever scope was explicitly named — including
 * a private scope or a quarantine bucket (`--scope unknown:legacy`). That is
 * deliberate owner access, identical in reach to api.recall's exact-match
 * for the same input; only NON-requested private/quarantine scopes stay
 * denied.
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

/**
 * Thrown when a caller requests a scope its role may not read. The HTTP layer
 * maps it to 403.
 */
export class ScopeForbiddenError extends Error {
  readonly scope: string;

  constructor(scope: string) {
    super(`scope ${scope} requires admin role`);
    this.name = 'ScopeForbiddenError';
    this.scope = scope;
  }
}

/**
 * True for scopes that default-deny hides: `<source>:private:*` and the
 * quarantine buckets. Naming one explicitly is what unlocks it, so naming one
 * is the act that needs authorization.
 */
export function isRestrictedScope(scope: string | null | undefined): boolean {
  if (!isScopeString(scope)) return false;
  // SAFETY: RECALL_DEFAULT_DENY_SCOPES is a readonly tuple of string
  // literals; widening the array (not the input) lets .includes() take any scope.
  // `:private:` anywhere, any case, matches the store's SQL default-deny (store.ts:894) so JS never admits what SQL hides.
  return isPrivateScope(scope) || /:private:/i.test(scope) || (RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(scope);
}

/** The identity a scope check runs against: a role plus any scope grants. */
export interface ScopeActor {
  role: 'admin' | 'member';
  scopes?: readonly string[];
}

/** True when `actor` may read `scope`: admin always; member needs an exact grant on a restricted scope. */
export function canReadScope(actor: ScopeActor, scope: string): boolean {
  if (actor.role === 'admin') return true;
  if (!isRestrictedScope(scope)) return true;
  return (actor.scopes ?? []).includes(scope);
}

/** Authorize an explicitly requested scope before any read honours it (ROADMAP Part VIII EI2: member scope grants). */
export function assertScopeRequestAllowed(actor: ScopeActor, requested: string | undefined): void {
  if (requested === undefined || requested === '') return;
  if (canReadScope(actor, requested)) return;
  throw new ScopeForbiddenError(requested);
}

/** Scope a derived row keeps from one source: the restricted scope itself, else null. */
export function derivationScope(scope: string | null | undefined): string | null {
  return isRestrictedScope(scope) ? (scope ?? null) : null;
}

/** The one derivation scope shared by every source, or `{ ok: false }` when
 *  two disagree, so the caller skips the derived row instead of under-scoping it. */
export function commonDerivationScope(
  scopes: readonly (string | null | undefined)[],
): { ok: true; scope: string | null } | { ok: false } {
  let common: string | null = null;
  let seen = false;
  for (const raw of scopes) {
    const scope = derivationScope(raw);
    if (!seen) {
      common = scope;
      seen = true;
    } else if (scope !== common) {
      return { ok: false };
    }
  }
  return { ok: true, scope: common };
}

/** Map-partition key for consolidate/dag producers: tenant + derivation scope,
 *  so a derived row never blends two restricted scopes or a mixed pair. */
export function derivationPartitionKey(tenantId: string, scope: string | null | undefined): string {
  return `${tenantId}\u0000${derivationScope(scope) ?? ''}`;
}
