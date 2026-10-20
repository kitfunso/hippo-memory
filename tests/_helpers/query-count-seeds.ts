// Fixed-size store seeds and statement patterns the per-row query count tests share; useQueryCountRoots removes their scratch roots.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, vi } from 'vitest';
import { apiCtx, type FullContext } from './api-ctx.js';
import { makeRoot } from './make-root.js';
import { MEMORY_SELECT_COLUMNS } from '../../src/store/sqlite/rows.js';
import { createMemory, Layer, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../../src/base/memory/memory.js';
import { adminActor } from '../../src/api/types.js';
import { withRequestStoresSync } from '../../src/db/request-stores.js';
import { writeEntriesTogether } from './root-forms.js';
import { openStore } from '../../src/store/sqlite/handles.js';
import { removeAfterRequest } from './one-request-per-test.js';

export const SIZES = [10, 200] as const;
export const ROW_READ = MEMORY_SELECT_COLUMNS;
/** The tenant scan's statement: one page of full rows of one tenant, which holds all of a small tenant. */
export const TENANT_READ =
  /FROM memories WHERE tenant_id = \? (AND \(created .*\) )?ORDER BY created ASC, id ASC LIMIT \?$/;
const roots: string[] = [];

export function useQueryCountRoots(): void {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of roots.splice(0)) removeAfterRequest(dir);
  });
}

export function freshRoot(label: string): string {
  const root = makeRoot(label);
  roots.push(root);
  return root;
}

export function ctxFor(root: string): FullContext {
  return apiCtx(root, 'default', adminActor('test:query-count'));
}

export function memory(content: string, extra: Partial<MemoryEntry> = {}): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra };
}

/** Seeds in one batch write, so a 200-row fixture stays well inside the test timeout on a loaded Windows runner. */
export function seed(
  ctx: FullContext,
  entries: readonly MemoryEntry[],
  after?: (db: ReturnType<typeof openStore>, e: MemoryEntry) => void,
): void {
  withRequestStoresSync(() => {
    writeEntriesTogether(ctx.hippoRoot, entries);
    if (!after) return;
    const db = openStore(ctx.hippoRoot);
    for (const e of entries) after(db, e);
  });
}

export function rows(n: number, label: string, extra: Partial<MemoryEntry> = {}): MemoryEntry[] {
  return Array.from({ length: n }, (_, i) => memory(`${label} memory number ${i} about the zephyrine cache`, extra));
}

/** Mirror files rewritten since `ageMirrors`, read from their mtimes. */
export function ageMirrors(root: string): () => number {
  const old = new Date('2001-01-01T00:00:00Z');
  const files = Object.values(Layer).flatMap((layer) => {
    const dir = path.join(root, layer);
    return fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => path.join(dir, f))
      : [];
  });
  for (const file of files) fs.utimesSync(file, old, old);
  return () => files.filter((file) => fs.existsSync(file) && fs.statSync(file).mtimeMs > old.getTime() + 1000).length;
}
