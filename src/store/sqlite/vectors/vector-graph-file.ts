// The sleep's save of a store's vector graph file, on a fresh grant: no runtime, session or
// worker fence, as a command's own open has.
import { saveVectorGraphIfDue, type GraphFileOptions } from '../../../db/vector-graph-build.js';
import { grantFor } from '../runtime/grant.js';

/** Builds and saves the store's vector graph file when it is missing or has drifted;
 * never throws. */
export function saveVectorGraphFile(hippoRoot: string, opts: GraphFileOptions): Promise<void> {
  return saveVectorGraphIfDue(grantFor({}), hippoRoot, opts);
}
