// The dedup read before a capture: which extracted texts the rows its reader sees already hold.
import type { CaptureDedup } from '../../base/records/capture.js';
import { storedTextKeys } from '../../base/util/same-text.js';
import type { HippoDbTier } from '../../base/ports/hippo-db.js';

/** Another tenant's or project's rows are hidden from the reader, so they never stop its own copy;
 * the write reads the same rows again in its own transaction. */
export async function textKeysHeldUnder(
  folder: { readonly store: HippoDbTier },
  dedup: CaptureDedup,
  texts: readonly string[],
): Promise<Set<string>> {
  const { tenantId, ...filter } = dedup;
  return storedTextKeys(await folder.store.hippoDb.captures.textsHolding(tenantId, texts, filter));
}
