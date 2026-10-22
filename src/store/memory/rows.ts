// What every in-memory group shares: ASCII case folding, the id sequences, the tenant-owned lookup, the audit
// append and the store-wide counters.
import type { JsonObject, JsonValue } from '../../base/util/json.js';
import { parseStoredObject, type StoredJsonSite } from '../../base/util/stored-json.js';
import type { MemoryEntry } from '../../base/memory/memory.js';
import type { AppendAuditOpts, AuditEvent } from '../port/types.js';
import { byIdOrder } from '../rules/order.js';
import type { MemoryTables } from './tables.js';

/** A key unique within a tenant; the NUL between the parts appears in no tenant id. */
export const tenantKey = (tenantId: string, key: string): string => `${tenantId}\u0000${key}`;

/** The store's LOWER and LIKE fold ASCII letters only. */
export const asciiFolded = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A stamp in SQL datetime('now') form: UTC to the second, a space before the time. */
export const hippoDbNow = (): string => new Date().toISOString().slice(0, 19).replace('T', ' ');

/** The id the next row of `table` gets; ids only grow, and a rolled-back write takes none. */
export const peekId = (t: MemoryTables, table: string): number => (t.seq.get(table) ?? 0) + 1;

/** Takes the next id of `table`. */
export function nextId(t: MemoryTables, table: string): number {
  const id = peekId(t, table);
  t.seq.set(table, id);
  return id;
}

type JsonOrBigint = JsonValue | bigint;
const isBigint = (value: JsonOrBigint): value is bigint => typeof value === 'bigint';
// A bigint is stored as its digits, where JSON.stringify alone throws.
const bigintAsText = (_key: string, value: JsonOrBigint): JsonOrBigint => (isBigint(value) ? value.toString() : value);

/** A JSON object column read back from `text`: anything but an object reads as empty. */
export function storedObject(text: string, site: StoredJsonSite): JsonObject {
  return parseStoredObject(site, text) ?? {};
}

/** The row `id` of `table` when the tenant holds it; another tenant's row reads as missing. */
export function ownedRow<K, R extends { readonly tenantId: string }>(
  table: ReadonlyMap<K, R>,
  tenantId: string,
  id: K,
): R | undefined {
  const row = table.get(id);
  return row?.tenantId === tenantId ? row : undefined;
}

/** Appends the rows in order, all or none: each is built before the first goes in. */
export function appendAudit(t: MemoryTables, events: readonly AppendAuditOpts[]): void {
  const ts = new Date().toISOString();
  const first = peekId(t, 'audit_log');
  const rows = events.map((event, i): AuditEvent => {
    const id = first + i;
    const metadata = storedObject(JSON.stringify(event.metadata ?? {}, bigintAsText), {
      table: 'audit_log',
      id,
      column: 'metadata_json',
    });
    return {
      id,
      ts,
      tenantId: event.tenantId,
      actor: event.actor,
      op: event.op,
      targetId: event.targetId ?? null,
      metadata,
    };
  });
  t.audit.push(...rows);
  if (rows.length > 0) t.seq.set('audit_log', first + rows.length - 1);
}

type Counter = 'total_remembered' | 'total_recalled' | 'total_forgotten';

export function counter(t: MemoryTables, name: Counter): number {
  return Number(t.meta.get(name) ?? '0');
}

export function bumpCounter(t: MemoryTables, name: Counter, by: number): void {
  t.meta.set(name, String(counter(t, name) + by));
}

/** The tenant's rows among `ids`, every tenant's under ALL_TENANTS, in the by-id read's order. */
export function rowsByIds(rows: Iterable<MemoryEntry>, ids: readonly string[], tenantOk: (t: string) => boolean) {
  const wanted = new Set(ids);
  return structuredClone([...rows].filter((e) => wanted.has(e.id) && tenantOk(e.tenantId)).sort(byIdOrder));
}
