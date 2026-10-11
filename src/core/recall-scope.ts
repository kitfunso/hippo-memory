/** Recall-side scope predicates, in a leaf module so search-both.ts can apply the same default-deny rule to searchBothHybrid's candidate loads without an
 * import cycle. src/api/index.ts imports these and re-exports them for back-compat (`api.isPrivateScope`, tests importing `passesScopeFilterForRecall`). */

import { BadRequestError, ForbiddenError } from './api-errors.js';
import { MAX_ID_LEN } from '../util/limits.js';

/** Literal scopes excluded from recall by default-deny when the caller passes no `scope`; read by the SQL clause in `loadSearchRows` and by
 * `passesScopeFilterForRecall`. Invariant: never empty, or quarantine scopes would pass both paths silently (the module-load assertion below pins this). */
export const RECALL_DEFAULT_DENY_SCOPES = ['unknown:legacy'] as const;

/** @internal Runtime guard against blanking a load-bearing literal array; `as const` arrays widen via `readonly T[]` at the call site, so the empty case
 * is reachable and testable. */
export function assertNonEmpty<T>(arr: readonly T[], name: string): void {
  if (arr.length === 0) {
    throw new Error(
      `${name} cannot be empty — would silently allow quarantine scopes`,
    );
  }
}

assertNonEmpty(RECALL_DEFAULT_DENY_SCOPES, 'RECALL_DEFAULT_DENY_SCOPES');

/** Source-agnostic private-scope detector: private means `<lowercase-source>:private:<rest>` (`slack:private:Cabc`; not `slack:public:x`, null, '',
 * 'private:foo'). The single source of truth for api.recall, the MCP server, the CLI and search-both.ts, so connector work cannot drift. */
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

/** JS half of the recall default-deny rule (SQL half: `loadSearchRows`). A non-empty `requested` needs an exact match;
 * otherwise `<source>:private:*` and `RECALL_DEFAULT_DENY_SCOPES` buckets are denied, while null, public scopes and the caller's `ownScope` pass. */
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

/** CLI `--scope` variant: an explicit `--scope X` UNLOCKS scope X on top of the default-admitted set rather than narrowing to X (api.recall keeps 'exact').
 * Includes private/quarantine scopes (owner access); a named personal scope never unlocks: the CLI has no caller identity. */
export function passesCliRecallScopeFilter(
  scope: string | null,
  requested: string | undefined,
): boolean {
  if (requested !== undefined && requested !== '' && !isPersonalScope(requested) && scope === requested) {
    return true;
  }
  return passesScopeFilterForRecall(scope, undefined);
}

/** Thrown when a caller requests a scope its role may not read; the HTTP layer maps it to 403. */
export class ScopeForbiddenError extends ForbiddenError {
  readonly scope: string;

  constructor(scope: string) {
    super(`scope ${scope} requires admin role`);
    this.name = 'ScopeForbiddenError';
    this.scope = scope;
  }
}

/** True for scopes default-deny hides (`<source>:private:*` and the quarantine buckets); naming one explicitly unlocks it, so naming one needs
 * authorization. */
export function isRestrictedScope(scope: string | null | undefined): boolean {
  if (!isScopeString(scope)) return false;
  // SAFETY: RECALL_DEFAULT_DENY_SCOPES is a readonly tuple of string literals; widening the array lets .includes() take any scope.
  // `:private:` anywhere, any case, matches the SQL default-deny in src/store/search-rows.ts so JS never admits what SQL hides.
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
