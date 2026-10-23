// Sleep holds ids, strengths and the few rows a pass changed; every other row is read back a page at a time by id.
import type { MemoryEntry } from '../../base/memory/memory.js';
import { chunked } from '../../base/util/chunked.js';
import type { StoreWith } from '../../store/port.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { EntryCursor } from '../../store/port/types.js';

/** The store's rows as this run loaded them: by created then id, with a dry run's half-life preview applied. */
export class SleepRows {
  /** Ids per keyset read; pageRows may be Infinity, one page of every row, and a LIMIT needs an integer. */
  private readonly idPage: number;
  /** The rows read so far that back a first-class object, asked page by page with the rows. */
  private readonly backed = new Set<string>();

  constructor(
    private readonly store: Pick<StoreWith<'consolidation'>, 'entriesByIds' | 'consolidation' | 'auditMaintenance'>,
    private readonly preview: ReadonlyMap<string, number>,
    readonly pageRows: number,
  ) {
    this.idPage = Math.min(pageRows, Number.MAX_SAFE_INTEGER - 1);
  }

  /** The rows for `ids` in that order; an id deleted since it was listed is skipped. */
  async read(ids: readonly string[]): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = [];
    for (const page of chunked(ids, this.pageRows)) {
      const byId = new Map((await this.store.entriesByIds(page, ALL_TENANTS)).map((e) => [e.id, e]));
      for (const id of await this.store.auditMaintenance.objectBackedAmong([...byId.keys()])) this.backed.add(id);
      for (const id of page) {
        const row = byId.get(id);
        if (row) out.push(this.loaded(row));
      }
    }
    return out;
  }

  /** Whether a row this run read backs a first-class object; a row it never read, such as a new merge, backs none. */
  backsObject(id: string): boolean {
    return this.backed.has(id);
  }

  /** Every row of the run, one keyset page of ids and then their rows at a time. */
  async *pages(): AsyncGenerator<MemoryEntry[]> {
    let after: EntryCursor | undefined;
    do {
      const page = await this.store.consolidation.entryIdsPage({ limit: this.idPage, after });
      yield await this.read(page.ids);
      after = page.next ?? undefined;
    } while (after);
  }

  /** The rows for `ids`, a page at a time. */
  async *pagesOf(ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
    for (const page of chunked(ids, this.pageRows)) yield await this.read(page);
  }

  private loaded(row: MemoryEntry): MemoryEntry {
    const halfLife = this.preview.get(row.id);
    return halfLife === undefined ? row : { ...row, halfLifeDays: halfLife };
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
  async set(rows: readonly MemoryEntry[]): Promise<void> {
    const fresh = rows.filter((row) => !this.held.has(row.id) && this.strength.has(row.id));
    const loaded = new Map((await this.stored.read(fresh.map((row) => row.id))).map((row) => [row.id, row]));
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
  async get(ids: readonly string[]): Promise<MemoryEntry[]> {
    const unchanged = ids.filter((id) => !this.held.has(id) && this.strength.has(id));
    const read = new Map<string, MemoryEntry>();
    for (const row of await this.stored.read(unchanged)) {
      read.set(row.id, { ...row, strength: this.strength.get(row.id)! });
    }
    return ids.flatMap((id) => this.held.get(id) ?? read.get(id) ?? []);
  }

  /** Every survivor with its place in run order, a page at a time. */
  async *indexed(): AsyncGenerator<readonly [number, MemoryEntry]> {
    const { pageRows } = this.stored;
    for (let start = 0; start < this.order.length; start += pageRows) {
      const page = this.order.slice(start, start + pageRows);
      const byId = new Map((await this.get(page)).map((row) => [row.id, row]));
      for (const [k, id] of page.entries()) {
        const row = byId.get(id);
        if (row) yield [start + k, row];
      }
    }
  }

  async *rows(): AsyncGenerator<MemoryEntry> {
    for await (const [, row] of this.indexed()) yield row;
  }

  /** The survivors among `ids`, a page at a time. */
  async *pagesOf(ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
    for (const page of chunked(ids, this.stored.pageRows)) yield await this.get(page);
  }
}
