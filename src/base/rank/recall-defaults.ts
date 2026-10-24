// Ranking defaults that `hippo recall --help` prints; the help and the rankers read the same value from here.

/** Share of the blended score that cosine takes. */
export const DEFAULT_EMBEDDING_WEIGHT = 0.6;
/** Default hops expanded from each seed (MVP; hard cap MAX_HOPS=3 reused from graph recall). */
export const DEFAULT_GRAPH_HOPS = 2;
/** Default number of top lexical seeds expanded from. */
export const DEFAULT_GRAPH_SEED_COUNT = 10;
