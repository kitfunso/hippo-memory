// Rows the old Claude import wrote (`claude-memory:<file>`), taken over by the notes they came from (plan design 10).
import path from 'node:path';
import type { DatabaseSyncLike } from '../db.js';
import type { MemoryEntry } from '../memory.js';
import { duplicateKey } from '../same-text.js';
import { selectLiveEntriesBySourcePrefix } from '../store.js';
import { matchLegacy, type LegacyTarget } from './plan.js';
import { MIN_ITEM_CHARS, storedText } from './source.js';
import type { Listing } from './types.js';

export const LEGACY_SOURCE_PREFIX = 'claude-memory:';
const LEGACY_TAG = 'claude-code-memory';

export interface ContainerLegacy {
  readonly adopt: Map<string, MemoryEntry[]>;
  readonly replace: Map<string, MemoryEntry[]>;
}

export interface LegacyWork {
  /** By container path. */
  readonly byContainer: ReadonlyMap<string, ContainerLegacy>;
  /** Rows about to take a note's key, which stop counting as text another path stored. */
  readonly adopted: ReadonlySet<string>;
}

/** Matched once across all the store's Claude folders, before any container's transaction; each adoption re-checks its row inside one. */
export function legacyWork(db: DatabaseSyncLike, tenantId: string, listings: readonly Listing[]): LegacyWork {
  const containers = listings.filter((l) => l.tool === 'claude-code').flatMap((l) => l.containers).filter((c) => c.readable);
  const rows = containers.length === 0
    ? []
    : selectLiveEntriesBySourcePrefix(db, tenantId, LEGACY_SOURCE_PREFIX).filter((r) => r.tags.includes(LEGACY_TAG));
  const byContainer = new Map<string, ContainerLegacy>();
  if (rows.length === 0) return { byContainer, adopted: new Set() };

  const refs: { readonly dir: string; readonly key: string }[] = [];
  const targets: LegacyTarget[] = [];
  for (const container of containers) {
    for (const item of container.items) {
      if (item.text.trim().length < MIN_ITEM_CHARS) continue;
      targets.push({ ref: String(refs.length), file: path.posix.basename(item.key), textKey: duplicateKey(storedText(item.text)) });
      refs.push({ dir: container.path, key: item.key });
    }
  }
  const match = matchLegacy(
    rows.map((r) => ({ id: r.id, file: r.source.slice(LEGACY_SOURCE_PREFIX.length), textKey: duplicateKey(r.content) })),
    targets,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const add = (pick: keyof ContainerLegacy, ref: string, id: string): void => {
    const { dir, key } = refs[Number(ref)];
    const row = byId.get(id);
    if (row === undefined) return;
    const found = byContainer.get(dir) ?? { adopt: new Map<string, MemoryEntry[]>(), replace: new Map<string, MemoryEntry[]>() };
    byContainer.set(dir, found);
    found[pick].set(key, [...(found[pick].get(key) ?? []), row]);
  };
  for (const [id, ref] of match.adopt) add('adopt', ref, id);
  for (const [ref, id] of match.replace) add('replace', ref, id);
  return { byContainer, adopted: new Set(match.adopt.keys()) };
}
