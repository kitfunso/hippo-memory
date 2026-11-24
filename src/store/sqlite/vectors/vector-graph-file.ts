import {
  saveVectorGraphFile as saveOnGrant,
  type GraphFileOptions,
} from '../../../db/vector-graph-build.js';
import { grantFor } from '../runtime/grant.js';

/** Builds and saves the store's vector graph file when it is missing or has drifted; never
 * throws. */
export function saveVectorGraphFile(hippoRoot: string, opts: GraphFileOptions): Promise<void> {
  return saveOnGrant(grantFor({}), hippoRoot, opts);
}
