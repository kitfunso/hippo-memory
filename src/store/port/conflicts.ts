// The Conflicts group's types: a conflict read with both members' columns, and the keyset page that carries them.
import type { KeysetPosition } from '../../base/util/keyset.js';
import type { TenantId } from '../../base/util/tenant.js';
import type { MemoryConflict } from '../../base/memory/conflict-wire.js';

export type { MemoryConflict };

/** The columns of one member that the api's reach, liveness and project rules read. */
export interface ConflictMember {
  readonly scope: string | null;
  readonly kind: string;
  readonly superseded_by: string | null;
  readonly origin_project: string | null;
}

/** A conflict and its two members from one read; a member is null only on an every-tenant read whose row is gone. */
export interface ConflictRow {
  readonly conflict: MemoryConflict;
  readonly a: ConflictMember | null;
  readonly b: ConflictMember | null;
}

export interface ConflictListQuery {
  /** ALL_TENANTS is host admin, which the api checks. */
  readonly tenantId: TenantId;
  /** '*' reads every status. */
  readonly status: string;
  readonly limit: number;
  /** Resume after this (updatedAt, id) position; the list runs newest change first. */
  readonly after?: KeysetPosition;
}

export interface ConflictRowPage {
  readonly rows: readonly ConflictRow[];
  /** The position the next page starts after, or null when this page was the last. */
  readonly next: KeysetPosition | null;
}

/** One member of a conflict, with the scope the api read and decided on. */
export interface ConflictSide {
  readonly id: string;
  readonly scope: string | null;
}

/** The domain's decision, applied as given: `weaken` scales the half-life by `halfLifeFactor`, never under
 * `minHalfLifeDays`; `reject` also tombstones the value and sweeps rows `ownScopeTouches(ownScope, scope)` admits. */
export type LoserFate =
  | { readonly kind: 'weaken'; readonly halfLifeFactor: number; readonly minHalfLifeDays: number }
  | { readonly kind: 'remove' }
  | { readonly kind: 'reject'; readonly ownScope: string | null };

export interface ConflictResolution {
  readonly conflictId: number;
  readonly keep: ConflictSide;
  readonly loser: ConflictSide;
  readonly fate: LoserFate;
  /** Named on the audit row, the tombstone and a raw loser's archive row. */
  readonly actor: string;
  /** Kept on the tombstone and a raw loser's archive row. */
  readonly reason: string;
  /** Core's clock, as `toISOString` gives it: the conflict's updatedAt and a rejected loser's tombstone time. */
  readonly at: string;
}

export interface Conflicts {
  /** One page, newest change first, each conflict with both members' columns from the same read. */
  list(query: ConflictListQuery): Promise<ConflictRowPage>;
  /** Conflict `conflictId`, any status, when both its members are in the tenant; else null. */
  get(tenantId: string, conflictId: number): Promise<ConflictRow | null>;
  /** Writes what the api decided, in one transaction, while the conflict is still open and each side still holds the
   * scope in `resolution`; false, with nothing written, otherwise. */
  resolve(tenantId: string, resolution: ConflictResolution): Promise<boolean>;
}
