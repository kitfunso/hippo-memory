### Added

- **Stores with 20,000 or more vectors now search a saved HNSW graph instead of scanning every vector.** `hippo embed` builds the graph and sleep keeps it current, inside hippo.db (schema v59). Searches whose scope filter admits few rows, smaller stores, and `HIPPO_VECTOR_INDEX=exact` keep the exact scan, so their results do not change.
