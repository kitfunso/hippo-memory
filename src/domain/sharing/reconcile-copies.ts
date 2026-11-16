// A global copy of a memory sleep replaced gets the same treatment, so the old value does not stay
// current there while the local store has moved on.
import type { MemoryEntry } from '../../base/memory/entry.js';
import { isSuperseded } from '../../base/memory/liveness.js';
import { isReplacedBy } from '../../base/memory/stale-mark.js';
import type { RequiredStore, StoreWith } from '../../base/ports/store.js';
import type { SupersedeLink } from '../../base/ports/store/consolidation.js';
import type { HeldText } from '../../base/ports/store/types.js';
import { duplicateKey } from '../../base/util/same-text.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';

/** A local memory sleep replaced, the newer one that replaced it, and how. */
export interface ReplacedPair {
  readonly oldId: string;
  readonly newId: string;
  readonly mode: SupersedeLink['mode'];
}

/** The current, unmarked global rows that hold `row`'s text under its project. */
function copiesOf(row: MemoryEntry, held: readonly HeldText[]): HeldText[] {
  const key = duplicateKey(row.content);
  return held.filter(
    (g) =>
      g.id !== undefined &&
      g.originProject === row.originProject &&
      duplicateKey(g.content) === key &&
      !isSuperseded(g) &&
      !isReplacedBy({ tags: g.tags ?? [] }),
  );
}

/** Hide toward the global copy of the new row if there is one, else a soft mark naming the local
 * new row; no link when the old text has no single copy. */
function linkFor(
  pair: ReplacedPair,
  tenantId: string,
  copies: { readonly old: readonly HeldText[]; readonly next: readonly HeldText[] },
): SupersedeLink | null {
  const [old, ...others] = copies.old;
  if (old?.id === undefined || others.length > 0) return null;
  const next = copies.next.find((g) => g.id !== undefined);
  if (next?.id !== undefined && pair.mode === 'hide') {
    return { tenantId, id: old.id, newId: next.id, mode: 'hide' };
  }
  return { tenantId, id: old.id, newId: next?.id ?? pair.newId, mode: 'soft' };
}

/** Applies each pair to the global copy of its old memory, in the order given; returns how many
 * global rows changed. */
export async function reconcileGlobalCopies(
  local: Pick<RequiredStore, 'entriesByIds'>,
  global: StoreWith<'captures' | 'consolidation'>,
  pairs: readonly ReplacedPair[],
): Promise<number> {
  if (pairs.length === 0) return 0;
  const ids = [...new Set(pairs.flatMap((p) => [p.oldId, p.newId]))];
  const rows = new Map((await local.entriesByIds(ids, ALL_TENANTS)).map((row) => [row.id, row]));
  const textsByTenant = new Map<string, string[]>();
  for (const row of rows.values()) {
    textsByTenant.set(row.tenantId, [...(textsByTenant.get(row.tenantId) ?? []), row.content]);
  }
  const held = new Map<string, HeldText[]>();
  for (const [tenantId, texts] of textsByTenant) {
    held.set(tenantId, await global.captures.textsHolding(tenantId, texts, { everyScope: true }));
  }
  const links: SupersedeLink[] = [];
  for (const pair of pairs) {
    const old = rows.get(pair.oldId);
    const next = rows.get(pair.newId);
    if (!old || !next || old.tenantId !== next.tenantId) continue;
    const here = held.get(old.tenantId) ?? [];
    const link = linkFor(pair, old.tenantId, { old: copiesOf(old, here), next: copiesOf(next, here) });
    if (link) links.push(link);
  }
  return links.length === 0 ? 0 : (await global.consolidation.supersedeLinks(links)).length;
}
