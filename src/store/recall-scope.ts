/**
 * Recall-side scope predicates, in a leaf module so shared.ts (which api.ts
 * imports) can apply the same default-deny rule to searchBothHybrid's internal
 * candidate loads without an import cycle. api.ts imports
 * these for its own call sites AND re-exports them for back-compat
 * (`api.isPrivateScope`, test imports of `passesScopeFilterForRecall`).
 */

import { BadRequestError, ForbiddenError } from '../core/api-errors.js';
import { MAX_ID_LEN } from '../util/http-util.js';

/**
 * Literal scopes excluded from recall by default-deny when the
 * caller passes no `scope`. The SQL clause in `loadSearchRows` and the JS
 * helper `passesScopeFilterForRecall` (src/api/index.ts) both read from this
 * constant. Adding a deny scope is a one-place change.
 *
 * Regex-based denies (e.g. `<source>:private:*`) stay in
 * `passesScopeFilterForRecall` as a separate JS step — they don't translate
 * cleanly to SQL.
 *
 * Invariant: never empty. An empty array would silently allow quarantine
 * scopes through both paths (SQL clause omitted, JS check vacuous). The
 * module-load assertion below pins this loudly.
 */
export const RECALL_DEFAULT_DENY_SCOPES = ['unknown:legacy'] as const;

/**
 * @internal Runtime guard against a future maintainer blanking a
 * load-bearing literal array. Extracted from the inline guard so the throw
 * path is directly testable. `as const` arrays widen via `readonly T[]` at
 * the call site so the empty case is reachable at runtime.
 */
export function assertNonEmpty<T>(arr: readonly T[], name: string): void {
  if (arr.length === 0) {
    throw new Error(
      `${name} cannot be empty — would silently allow quarantine scopes`,
    );
  }
}

assertNonEmpty(RECALL_DEFAULT_DENY_SCOPES, 'RECALL_DEFAULT_DENY_SCOPES');

/**
 * Source-agnostic private-scope detector. A scope string is treated
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

export const PERSONAL_SCOPE_PREFIX = 'personal:private:';
// The scope must fit the 256-character scope caps, so the owner gets what the prefix leaves.
export const PERSONAL_OWNER_MAX = MAX_ID_LEN - PERSONAL_SCOPE_PREFIX.length;

/** True for a `personal:private:<owner>` scope, any case, so a case variant is never mistaken for a team scope. */
export function isPersonalScope(scope: string | null | undefined): boolean {
  if (!isScopeString(scope)) return false;
  return /^personal:private:/i.test(scope);
}

/** The caller's own personal scope, or null when it has no owner that can hold one. */
export function personalScopeOf(actor: { owner?: string } | undefined): string | null {
  const owner = actor?.owner;
  if (!owner || owner.length > PERSONAL_OWNER_MAX || /\p{Cc}/u.test(owner)) return null;
  return `${PERSONAL_SCOPE_PREFIX}${owner}`;
}

/** Refuses a client-sent `personal:` scope: only the server stamps one, from the caller's owner. */
export function assertClientScope(scope: string | null | undefined): void {
  if (isScopeString(scope) && /^personal:/i.test(scope)) {
    throw new BadRequestError(`scope ${scope} is reserved: the server sets personal scopes itself`);
  }
}

/** True when `actor` may change or delete a row in `scope`: any non-personal scope, or its own personal one. */
export function canTouchScope(actor: { owner?: string }, scope: string | null): boolean {
  return ownScopeTouches(personalScopeOf(actor), scope);
}

/** canTouchScope for a caller known by its own personal scope, as a store method receives it. */
export function ownScopeTouches(ownScope: string | null, scope: string | null): boolean {
  return !isPersonalScope(scope) || scope === ownScope;
}

/**
 * Recall-side scope filter — the canonical JS half of the recall default-deny
 * rule (the SQL half lives in `loadSearchRows` via `loadRecallSearchEntries`).
 *
 * - When `requested` is set and non-empty: exact match required.
 * - When `requested` is undefined/empty: default-deny on any
 *   `<source>:private:*` scope and on the `RECALL_DEFAULT_DENY_SCOPES`
 *   quarantine buckets. `null` and public scopes pass, and so does `ownScope`, the caller's own personal scope.
 */
export function passesScopeFilterForRecall(
  scope: string | null,
  requested: string | undefined,
  ownScope?: string | null,
): boolean {
  if (requested !== undefined && requested !== '') {
    return scope === requested;
  }
  return !isRestrictedScope(scope) || (ownScope != null && scope === ownScope);
}

export interface SqlFragment {
  sql: string;
  params: string[];
}

/** SQL twin of the no-request arm of passesScopeFilterForRecall; `ownScope` is bound and compared with `=`, so `%` or `_` in an owner match nothing extra. */
export function scopeAdmitSql(col: '' | 'm.', ownScope?: string | null): SqlFragment {
  const placeholders = RECALL_DEFAULT_DENY_SCOPES.map(() => '?').join(', ');
  const admitted = `${col}scope IS NULL OR (${col}scope NOT IN (${placeholders}) AND ${col}scope NOT LIKE '%:private:%')`;
  if (ownScope == null) return { sql: `(${admitted})`, params: [...RECALL_DEFAULT_DENY_SCOPES] };
  // The own arm sits inside the outer parentheses so a caller's `AND ${sql}` cannot split it off.
  return { sql: `(${admitted} OR ${col}scope = ?)`, params: [...RECALL_DEFAULT_DENY_SCOPES, ownScope] };
}

/** SQL twin of canTouchScope, which is also canReadScope for an admin: every row but
 * another person's personal one. LIKE folds ASCII case as isPersonalScope's /i does. */
export function touchableScopeSql(col: '' | 'm.', ownScope?: string | null): SqlFragment {
  const notPersonal = `${col}scope IS NULL OR ${col}scope NOT LIKE '${PERSONAL_SCOPE_PREFIX}%'`;
  if (ownScope == null) return { sql: `(${notPersonal})`, params: [] };
  return { sql: `(${notPersonal} OR ${col}scope = ?)`, params: [ownScope] };
}

/**
 * The CLI `--scope` variant of the recall filter (JS half of the
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
 * denied. A named personal scope never unlocks: the CLI has no caller identity to check it against.
 */
export function passesCliRecallScopeFilter(
  scope: string | null,
  requested: string | undefined,
): boolean {
  if (requested !== undefined && requested !== '' && !isPersonalScope(requested) && scope === requested) {
    return true;
  }
  return passesScopeFilterForRecall(scope, undefined);
}

/**
 * Thrown when a caller requests a scope its role may not read. The HTTP layer
 * maps it to 403.
 */
export class ScopeForbiddenError extends ForbiddenError {
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
  // `:private:` anywhere, any case, matches the store's SQL default-deny (store/search-rows.ts) so JS never admits what SQL hides.
  return isPrivateScope(scope) || /:private:/i.test(scope) || (RECALL_DEFAULT_DENY_SCOPES as readonly string[]).includes(scope);
}

/** The identity a scope check runs against: a role, any scope grants, and the person who owns the key. */
export interface ScopeActor {
  role: 'admin' | 'member';
  scopes?: readonly string[];
  owner?: string;
}

/** Personal rows answer to their owner alone: role, key grants and resolver scopes never
 * open one. Else admin reads all; a member needs an exact grant on a restricted scope. */
export function canReadScope(actor: ScopeActor, scope: string): boolean {
  if (isPersonalScope(scope)) return scope === personalScopeOf(actor);
  if (actor.role === 'admin') return true;
  if (!isRestrictedScope(scope)) return true;
  return (actor.scopes ?? []).includes(scope);
}

/** Authorize an explicitly requested scope before any read honours it (member scope grants). */
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

/** Map-partition key for consolidate/dag/dedup producers: tenant + derivation scope + origin project,
 *  so a derived row never blends two restricted scopes, a mixed pair, or two projects. */
export function derivationPartitionKey(
  tenantId: string, scope: string | null | undefined, origin: string | null | undefined,
): string {
  const project = origin === undefined ? '\u0002' : origin ?? '\u0001'; // unstamped, unknown and named never share a bucket
  return `${tenantId}\u0000${derivationScope(scope) ?? ''}\u0000${project}`;
}
