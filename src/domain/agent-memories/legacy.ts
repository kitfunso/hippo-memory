// Rows the old Claude import wrote (`claude-memory:<file>`), taken over by the notes they came
// from.
import path from 'node:path';
import type { MemoryEntry } from '../../base/memory/entry.js';
import { duplicateKey } from '../../base/util/same-text.js';
import { maskEmails, redactSecretsStrict } from '../../base/util/secret-detect.js';
import { liveUnder } from './container-view.js';
import { matchLegacy, type LegacyTarget } from './plan.js';
import { fileOfKey, isPartKey, MIN_ITEM_CHARS, storedText } from './source.js';
import type { Container, ImportStore, Listing, MemoryItem } from './types.js';

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

interface LegacyTargets {
  readonly refs: readonly { readonly dir: string; readonly key: string }[];
  readonly targets: readonly LegacyTarget[];
}

// A long note's old row goes to its first part that will be written, so a secret part is passed.
function noTarget(item: MemoryItem): boolean {
  if (item.text.trim().length < MIN_ITEM_CHARS) return true;
  return isPartKey(item.key) && (item.flagged === true || redactSecretsStrict(item.text) !== item.text);
}

function legacyTargets(containers: readonly Container[]): LegacyTargets {
  const refs: { readonly dir: string; readonly key: string }[] = [];
  const targets: LegacyTarget[] = [];
  for (const container of containers) {
    for (const item of container.items.filter((i) => !noTarget(i))) {
      const note = fileOfKey(item.key);
      targets.push({
        ref: String(refs.length),
        file: path.posix.basename(note),
        note: `${container.path}\n${note}`,
        textKey: duplicateKey(storedText(item.text)),
      });
      refs.push({ dir: container.path, key: item.key });
    }
  }
  return { refs, targets };
}

/**
 * Matched once across all the store's Claude folders, before any container's transaction; each
 * adoption re-checks its row inside one.
 */
export async function legacyWork(
  store: Pick<ImportStore, 'entriesWhere'>,
  tenantId: string,
  listings: readonly Listing[],
): Promise<LegacyWork> {
  const containers = listings
    .filter((l) => l.tool === 'claude-code')
    .flatMap((l) => l.containers)
    .filter((c) => c.readable);
  const rows =
    containers.length === 0
      ? []
      : (await liveUnder(store, tenantId, LEGACY_SOURCE_PREFIX)).filter((r) =>
          r.tags.includes(LEGACY_TAG),
        );
  const byContainer = new Map<string, ContainerLegacy>();
  if (rows.length === 0) return { byContainer, adopted: new Set() };

  const { refs, targets } = legacyTargets(containers);
  const match = matchLegacy(
    // The old import kept emails in clear, and targets are masked; without the mask those rows
    // never matched and imported twice.
    rows.map((r) => ({
      id: r.id,
      file: r.source.slice(LEGACY_SOURCE_PREFIX.length),
      textKey: duplicateKey(maskEmails(r.content)),
    })),
    targets,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const add = (pick: keyof ContainerLegacy, ref: string, id: string): void => {
    const { dir, key } = refs[Number(ref)];
    const row = byId.get(id);
    if (row === undefined) return;
    const found = byContainer.get(dir) ?? {
      adopt: new Map<string, MemoryEntry[]>(),
      replace: new Map<string, MemoryEntry[]>(),
    };
    byContainer.set(dir, found);
    found[pick].set(key, [...(found[pick].get(key) ?? []), row]);
  };
  for (const [id, ref] of match.adopt) add('adopt', ref, id);
  for (const [ref, ids] of match.replace) for (const id of ids) add('replace', ref, id);
  return { byContainer, adopted: new Set(match.adopt.keys()) };
}
