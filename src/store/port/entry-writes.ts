import type { MemoryEntry } from '../../core/memory.js';

export interface EntryWrite {
  readonly entry: MemoryEntry;
  readonly actor: string;
}

/** Who acts on which of a tenant's rows; `ownScope` is the caller's
 * personal scope, so every other personal row is out of reach. */
export interface EntryTarget {
  readonly tenantId: string;
  readonly actor: string;
  readonly ownScope: string | null;
}

export interface OutcomeWrite extends EntryTarget {
  readonly ids: readonly string[];
  readonly good: boolean;
}

export interface SupersedeWrite extends EntryTarget {
  readonly oldId: string;
  readonly successor: MemoryEntry;
}

export interface EntryRemoval extends EntryTarget {
  readonly id: string;
}

export interface RawArchive extends EntryRemoval {
  readonly reason: string;
}

export interface PinWrite extends EntryRemoval {
  readonly pinned: boolean;
}

/** The memory-row writes behind remember, outcome, pin, supersede, archive and forget. Each writes its audit rows in
 * the write's own transaction, a child row's change marks its level 2 or 3 summary parent dirty (one
 * summary_marked_dirty row on the flip), and the schema's rules hold. */
export interface EntryWrites {
  /** Upserts the row, its full-text row and one remember row ({kind, scope}) in the entry's tenant; an undefined
   * origin_project takes the store's fallback. An id another tenant holds rejects with ConflictError. Content the
   * tenant tombstoned rejects with RejectedValueError; one reject_refusal row follows the rollback, best effort. */
  writeEntry(write: EntryWrite): Promise<void>;
  /** Per id in order, a row of the tenant within reach gets `entryAfterOutcome` (rewrite as writeEntry does) and one
   * outcome row ({good}); other ids skipped. Each read holds the row lock to commit (SELECT ... FOR UPDATE), so a
   * concurrent supersede is not undone. Resolves to the ids applied, repeats kept. */
  applyOutcome(outcome: OutcomeWrite): Promise<string[]>;
  /** Rewrites the row as writeEntry does plus one pin row ({pinned}); out of reach rejects as forget does. */
  setPinned(pin: PinWrite): Promise<MemoryEntry>;
  /** Sets the old row's superseded_by if it is within reach and not yet superseded (both checked in the transaction),
   * else rejects NotFoundError or ConflictError. Then writes the successor as writeEntry does and one supersede row
   * ({newId}), all or nothing. */
  supersede(write: SupersedeWrite): Promise<void>;
  /** Moves a raw row to raw_archive (metadata only, no content), deletes it and its full-text row and writes one
   * archive_raw row ({reason}); resolves to the archived_at written. A row out of reach rejects with NotFoundError
   * `memory not found: <id>`, any other kind with BadRequestError. */
  archiveRaw(archive: RawArchive): Promise<string>;
  /** Deletes the row and its full-text row and writes one forget row; a raw row rejects, being append-only. A row out
   * of reach rejects with NotFoundError `memory not found: <id>`. Archive and forget then add one to the store-wide
   * forgotten counter, best effort. */
  forget(removal: EntryRemoval): Promise<void>;
}
