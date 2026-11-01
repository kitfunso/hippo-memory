// How a dedup run's pairs split by the layers of the two rows, so the CLI and sleep report the
// same groups.
import { Layer } from './entry.js';

/** A dedup run's pairs by how the two rows relate: both semantic, both episodic, or across
 * layers. */
export interface DedupGroups<P> {
  readonly semantic: P[];
  readonly episodic: P[];
  readonly cross: P[];
}

export function groupDedupPairs<
  P extends { readonly keptLayer: string; readonly removedLayer: string },
>(pairs: readonly P[]): DedupGroups<P> {
  const sameLayer = (layer: Layer) => (p: P) => p.keptLayer === layer && p.removedLayer === layer;
  return {
    semantic: pairs.filter(sameLayer(Layer.Semantic)),
    episodic: pairs.filter(sameLayer(Layer.Episodic)),
    cross: pairs.filter((p) => p.keptLayer !== p.removedLayer),
  };
}
