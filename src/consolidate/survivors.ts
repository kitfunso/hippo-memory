// Sleep holds ids, strengths and the few rows a pass changed; every other row is read back a page at a time by id.
import type { MemoryEntry } from '../core/memory.js';
import type { Consolidation } from '../store/port.js';
import { chunked } from '../util/chunked.js';

/** Rows per read: one id-list query's worth, so a page is one statement and about a megabyte of rows. */
export const SLEEP_PAGE_ROWS = 500;

/** The store's rows as this run loaded them: by created then id, with a dry run's half-life preview applied. */
export class SleepRows {
  constructor(
    private readonly store: Pick<Consolidation, 'entriesByIds'>,
    /** Every memory id when the run began. Ids, not a LIMIT keyset: no index orders memories by created then id
     * across tenants, so each keyset page would sort the table again. */
    readonly ids: readonly string[],
    private readonly preview: ReadonlyMap<string, number>,
    readonly pageRows: number,
  ) {}

  /** The rows for `ids` in that order; an id deleted since it was listed is skipped. */
  read(ids: readonly string[]): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const page of chunked(ids, this.pageRows)) {
      const byId = this.store.entriesByIds(page);
      for (const id of page) {
        const row = byId.get(id);
        if (row) out.push(this.loaded(row));
      }
    }
    return out;
  }

  /** Every row of the run, a page at a time. */
  pages(): Generator<MemoryEntry[]> {
    return this.pagesOf(this.ids);
  }

  /** The rows for `ids`, a page at a time. */
  *pagesOf(ids: readonly string[]): Generator<MemoryEntry[]> {
    for (const page of chunked(ids, this.pageRows)) yield this.read(page);
  }

  private loaded(row: MemoryEntry): MemoryEntry {
    const halfLife = this.preview.get(row.id);
    return halfLife === undefined ? row : { ...row, half_life_days: halfLife };
  }
}

/** The rows decay kept, in run order: each one read back with its decayed strength unless a pass changed it. */
export class Survivors {
  private readonly order: string[] = [];
  private readonly strength = new Map<string, number>();
  private readonly held = new Map<string, MemoryEntry>();
  /** Each changed stored row as loaded, so the flush keeps what other writers changed meanwhile. */
  readonly bases = new Map<string, MemoryEntry>();

  constructor(private readonly stored: SleepRows) {}

  get size(): number {
    return this.order.length;
  }

  /** A stored row decay kept, at `strength`. */
  keep(id: string, strength: number): void {
    this.order.push(id);
    this.strength.set(id, strength);
  }

  /** A new row added at the end. */
  push(row: MemoryEntry): void {
    this.order.push(row.id);
    this.held.set(row.id, row);
  }

  /** Changed rows, each kept in its place. */
  set(rows: readonly MemoryEntry[]): void {
    const fresh = rows.filter((row) => !this.held.has(row.id) && this.strength.has(row.id));
    const loaded = new Map(this.stored.read(fresh.map((row) => row.id)).map((row) => [row.id, row]));
    // A row gone since decay read it is its own base, so the flush skips it rather than write it back.
    for (const row of fresh) this.bases.set(row.id, loaded.get(row.id) ?? row);
    for (const row of rows) this.held.set(row.id, row);
  }

  /** Puts `row` in place of the survivor at `index`, or drops that survivor when `row` is null. */
  replaceAt(index: number, row: MemoryEntry | null): void {
    const id = this.order[index];
    if (id === undefined) return;
    this.strength.delete(id);
    this.held.delete(id);
    if (!row) {
      this.order.splice(index, 1);
      return;
    }
    this.order[index] = row.id;
    this.held.set(row.id, row);
  }

  /** The survivors among `ids`, in that order. */
  get(ids: readonly string[]): MemoryEntry[] {
    const unchanged = ids.filter((id) => !this.held.has(id) && this.strength.has(id));
    const read = new Map<string, MemoryEntry>();
    for (const row of this.stored.read(unchanged)) read.set(row.id, { ...row, strength: this.strength.get(row.id)! });
    return ids.flatMap((id) => this.held.get(id) ?? read.get(id) ?? []);
  }

  /** Every survivor with its place in run order, a page at a time. */
  *indexed(): Generator<readonly [number, MemoryEntry]> {
    const { pageRows } = this.stored;
    for (let start = 0; start < this.order.length; start += pageRows) {
      const page = this.order.slice(start, start + pageRows);
      const byId = new Map(this.get(page).map((row) => [row.id, row]));
      for (const [k, id] of page.entries()) {
        const row = byId.get(id);
        if (row) yield [start + k, row];
      }
    }
  }

  *rows(): Generator<MemoryEntry> {
    for (const [, row] of this.indexed()) yield row;
  }

  /** The survivors among `ids`, a page at a time. */
  *pagesOf(ids: readonly string[]): Generator<MemoryEntry[]> {
    for (const page of chunked(ids, this.stored.pageRows)) yield this.get(page);
  }
}
