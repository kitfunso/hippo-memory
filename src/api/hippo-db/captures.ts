// A capture on hippo.db's local tier: the dedup read before it, the write that stores each new text
// once, and a dry run's question to that write's gate.
import type { MemoryEntry } from '../../base/memory/entry.js';
import type {
  CaptureDedup,
  CapturedOutcome,
  CaptureTally,
  CaptureWriteOptions,
} from '../../base/records/capture.js';
import { duplicateKey, storedTextKeys } from '../../base/util/same-text.js';
import type { HippoDbTier } from '../../base/ports/hippo-db.js';

type CaptureFolder = { readonly store: HippoDbTier };

/** Another tenant's or project's rows are hidden from the reader, so they never stop its own copy;
 * the write reads the same rows again in its own transaction. */
export async function textKeysHeldUnder(
  folder: CaptureFolder,
  dedup: CaptureDedup,
  texts: readonly string[],
): Promise<Set<string>> {
  const { tenantId, ...filter } = dedup;
  return storedTextKeys(await folder.store.hippoDb.captures.textsHolding(tenantId, texts, filter));
}

/** The entries to write, and per item the entry whose outcome it takes, or -1 for a text the
 * store already holds. */
interface CapturePlan {
  readonly entries: MemoryEntry[];
  readonly keys: string[];
  readonly slots: number[];
}

/** One entry per new text: building can throw, so a held text or a repeat within the batch is
 * never built. */
function planCapture<I extends { readonly content: string }>(
  items: readonly I[],
  held: ReadonlySet<string>,
  build: (item: I) => MemoryEntry,
): CapturePlan {
  const plan: CapturePlan = { entries: [], keys: [], slots: [] };
  const firstSlot = new Map<string, number>();
  for (const item of items) {
    const key = duplicateKey(item.content);
    let slot = held.has(key) ? -1 : firstSlot.get(key);
    if (slot === undefined) {
      slot = plan.entries.push(build(item)) - 1;
      plan.keys.push(key);
      firstSlot.set(key, slot);
    }
    plan.slots.push(slot);
  }
  return plan;
}

/** Writes each new text once; a repeat of a captured text in the same batch counts as skipped, as
 * a held one does. `held` gains each captured text, and the entries written come back. */
export async function captureOnce<I extends { readonly content: string }>(
  folder: CaptureFolder,
  items: readonly I[],
  build: (item: I) => MemoryEntry,
  held: Set<string>,
  opts: CaptureWriteOptions,
): Promise<{ tally: CaptureTally; captured: MemoryEntry[] }> {
  const plan = planCapture(items, held, build);
  const outcomes = await folder.store.hippoDb.captures.write(plan.entries, opts);
  const tally: CaptureTally = { captured: 0, skipped: 0, rejected: 0 };
  const counted = new Set<number>();
  for (const slot of plan.slots) {
    const outcome: CapturedOutcome = slot === -1 ? 'skipped' : outcomes[slot];
    tally[counted.has(slot) && outcome === 'captured' ? 'skipped' : outcome]++;
    counted.add(slot);
  }
  const captured: MemoryEntry[] = [];
  outcomes.forEach((outcome, i) => {
    if (outcome !== 'captured') return;
    held.add(plan.keys[i]);
    captured.push(plan.entries[i]);
  });
  return { tally, captured };
}

/** Whether the write's rejected-value gate would refuse each entry, asked as the gate asks it, by
 * the entry's own tenant; writes nothing. */
export function refusedOnWrite(
  folder: CaptureFolder,
  entries: readonly MemoryEntry[],
): Promise<boolean[]> {
  return folder.store.hippoDb.rejections.refusedAmong(
    entries.map((entry) => ({
      tenantId: entry.tenantId,
      entryId: entry.id,
      content: entry.content,
    })),
  );
}
