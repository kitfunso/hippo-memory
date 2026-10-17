// The Conflicts group's types: a conflict read with both members' columns, and the keyset page that carries them.
import type { KeysetPosition } from '../../util/keyset.js';
import type { MemoryConflict } from '../rows.js';

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
