// The root entry's learning loop: lessons from errors, the share score and the global store.
import type { MemoryEntry } from '../base/memory/entry.js';
import { captureError as captureErrorAt } from '../domain/learn/autolearn.js';
import { evalNow } from '../infra/eval-switches.js';

export { extractLessons, partitionLessons } from '../domain/learn/autolearn.js';
export { getGlobalRoot } from '../host/global-store.js';
export { transferScore } from '../domain/sharing/share.js';

/** A failed command as an error memory, stamped at HIPPO_FAKE_NOW or the wall clock. */
export function captureError(
  exitCode: number,
  stderr: string,
  command: string,
  tenantId?: string,
): MemoryEntry {
  return captureErrorAt(exitCode, stderr, command, tenantId, evalNow());
}
