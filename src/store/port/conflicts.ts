// The Conflicts group's types: a conflict read with both members' columns, and the keyset page that carries them.
import type { KeysetPosition } from '../../util/keyset.js';

/** The columns of one member that the api's reach, liveness and project rules read. */
export interface ConflictMember {
  readonly scope: string | null;
  readonly kind: string;
  readonly superseded_by: string | null;
  readonly origin_project: string | null;
}

/** A conflict and its two members from one JOIN; a member is null only on an every-tenant read whose row is gone. */
export interface ConflictRow {
  readonly conflict: MemoryConflict;
  readonly a: ConflictMember | null;
  readonly b: ConflictMember | null;
}

export interface ConflictListQuery {
  /** null reads every tenant: host admin, which the api checks. */
  readonly tenantId: string | null;
  /** '*' reads every status. */
  readonly status: string;
  readonly limit: number;
  /** Resume after this (updated_at, id) position; the list runs newest change first. */
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

/** What the api decided for the loser. `reject` also tombstones its value and removes the tenant's other rows holding
 * it in a scope `ownScopeTouches(ownScope, scope)` admits, checked inside the store's write. */
export type LoserFate =
  | { readonly kind: 'weaken' }
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
}

export interface MemoryConflict {
  id: number;
  memory_a_id: string;
  memory_b_id: string;
  reason: string;
  score: number;
  status: string;
  detected_at: string;
  updated_at: string;
}
