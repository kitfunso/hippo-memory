import type { MemoryEntry } from '../../base/memory/entry.js';
import { chunked } from '../../base/util/chunked.js';
import type { StoreWith } from '../../base/ports/store.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { EntryCursor } from '../../base/ports/store/types.js';

/** The store's rows as this run loaded them: by created then id, with a dry run's half-life
 * preview applied. */
export class SleepRows {
  private readonly idPage: number;
  private readonly backed = new Set<string>();

  constructor(
    private readonly store: Pick<
      StoreWith<'consolidation' | 'auditMaintenance'>,
      'entriesByIds' | 'consolidation' | 'auditMaintenance'
    >,
    private readonly preview: ReadonlyMap<string, number>,
    readonly pageRows: number,
  ) {
    this.idPage = Math.min(pageRows, Number.MAX_SAFE_INTEGER - 1);
  }

  async read(ids: readonly string[]): Promise<MemoryEntry[]> {
    const out: MemoryEntry[] = [];
    for (const page of chunked(ids, this.pageRows)) {
      const byId = new Map(
        (await this.store.entriesByIds(page, ALL_TENANTS)).map((e) => [e.id, e]),
      );
      for (const id of await this.store.auditMaintenance.objectBackedAmong([...byId.keys()])) {
        this.backed.add(id);
      }
      for (const id of page) {
        const row = byId.get(id);
        if (row) out.push(this.loaded(row));
      }
    }
    return out;
  }

  backsObject(id: string): boolean {
    return this.backed.has(id);
  }

  async *pages(): AsyncGenerator<MemoryEntry[]> {
    let after: EntryCursor | undefined;
    do {
      const page = await this.store.consolidation.entryIdsPage({ limit: this.idPage, after });
      yield await this.read(page.ids);
      after = page.next ?? undefined;
    } while (after);
  }

  async *pagesOf(ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
    for (const page of chunked(ids, this.pageRows)) yield await this.read(page);
  }

  private loaded(row: MemoryEntry): MemoryEntry {
    const halfLife = this.preview.get(row.id);
    return halfLife === undefined ? row : { ...row, halfLifeDays: halfLife };
  }
}

/** The rows decay kept, in run order: each one read back with its decayed strength unless a pass
 * changed it. */
export class Survivors {
  private readonly order: string[] = [];
  private readonly strength = new Map<string, number>();
  private readonly held = new Map<string, MemoryEntry>();
  readonly bases = new Map<string, MemoryEntry>();

  constructor(private readonly stored: SleepRows) {}

  get size(): number {
    return this.order.length;
  }

  keep(id: string, strength: number): void {
    this.order.push(id);
    this.strength.set(id, strength);
  }

  push(row: MemoryEntry): void {
    this.order.push(row.id);
    this.held.set(row.id, row);
  }

  async set(rows: readonly MemoryEntry[]): Promise<void> {
    const fresh = rows.filter((row) => !this.held.has(row.id) && this.strength.has(row.id));
    const loaded = new Map(
      (await this.stored.read(fresh.map((row) => row.id))).map((row) => [row.id, row]),
    );
    for (const row of fresh) this.bases.set(row.id, loaded.get(row.id) ?? row);
    for (const row of rows) this.held.set(row.id, row);
  }

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

  changed(): MemoryEntry[] {
    return [...this.held.values()];
  }

  has(id: string): boolean {
    return this.held.has(id) || this.strength.has(id);
  }

  async get(ids: readonly string[]): Promise<MemoryEntry[]> {
    const unchanged = ids.filter((id) => !this.held.has(id) && this.strength.has(id));
    const read = new Map<string, MemoryEntry>();
    for (const row of await this.stored.read(unchanged)) {
      read.set(row.id, { ...row, strength: this.strength.get(row.id)! });
    }
    return ids.flatMap((id) => this.held.get(id) ?? read.get(id) ?? []);
  }

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

  async *pagesOf(ids: readonly string[]): AsyncGenerator<MemoryEntry[]> {
    for (const page of chunked(ids, this.stored.pageRows)) yield await this.get(page);
  }
}
