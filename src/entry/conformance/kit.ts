// What every store conformance case shares: the runner it registers with, a fresh store per case,
// and the rows a case writes through the port alone.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type { HippoStore } from '../../base/ports/store-index.js';
import type { EntryTarget } from '../../base/ports/store/entry-writes.js';
import { errorMessage } from '../../base/util/log.js';
import { createMemory } from '../memory.js';

interface Expectation<T> {
  toBe(expected: T): void;
  /** Deep equality, as vitest's and jest's toEqual compare. */
  toEqual(expected: T): void;
}

/** The three functions of vitest, jest or node:test that the suite registers its checks with. */
export interface ConformanceRunner {
  describe(name: string, body: () => void): void;
  it(name: string, body: () => Promise<void>): void;
  expect<T>(actual: T): Expectation<T>;
}

/** The runner, and a function that opens a fresh, empty store for each case. */
export interface ConformanceSuite {
  readonly runner: ConformanceRunner;
  readonly open: () => Promise<HippoStore> | HippoStore;
}

export const TENANT = 'acme';
export const OTHER_TENANT = 'globex';
export const AT = '2026-03-01T12:00:00.000Z';
export const ACTOR = 'conformance';

/** An admin of `TENANT` acting on its rows. */
export const ADMIN: EntryTarget = { tenantId: TENANT, actor: ACTOR, role: 'admin', ownScope: null };

/** One check, run on a fresh, empty store. */
export type Check = (store: HippoStore, expect: ConformanceRunner['expect']) => Promise<void>;

/** Registers each check under `title`, each on its own store, closed when the check ends. */
export function registerChecks(
  { runner, open }: ConformanceSuite,
  title: string,
  checks: Readonly<Record<string, Check>>,
): void {
  const { describe, it, expect } = runner;
  describe(title, () => {
    for (const [name, check] of Object.entries(checks)) {
      it(name, async () => {
        const store = await open();
        try {
          await check(store, expect);
        } finally {
          await store.close();
        }
      });
    }
  });
}

/** `run`'s rejection as `<name>: <message>`, or undefined when it resolves. */
export async function failureOf<R>(run: () => Promise<R>): Promise<string | undefined> {
  try {
    await run();
  } catch (err) {
    return `${err instanceof Error ? err.name : 'thrown'}: ${errorMessage(err)}`;
  }
  return undefined;
}

/** A row of `tenantId` in project `proj`, created `minute` minutes after AT, so cases order rows
 * by a time they set. */
export function rowOf(
  tenantId: string,
  content: string,
  minute: number,
  over: Partial<MemoryEntry> = {},
): MemoryEntry {
  const created = new Date(Date.parse(AT) + minute * 60_000).toISOString();
  return { ...createMemory(content, { tenantId }), originProject: 'proj', created, ...over };
}

export async function writeRows(store: HippoStore, rows: readonly MemoryEntry[]): Promise<void> {
  for (const entry of rows) await store.entryWrites.writeEntry({ entry, actor: ACTOR });
}

export const idsOf = (rows: readonly { readonly id: string }[]): string[] => rows.map((r) => r.id);
