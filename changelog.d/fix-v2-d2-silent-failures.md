### Fixed

- The cross-encoder reranker now warns when the model loads but every scoring call fails, instead of looking healthy while recall keeps the base order.
- A stalled compaction record with unreadable items is logged, and the other stalled records still replay.
- A busy or locked database on open no longer turns off full-text search; only a missing fts5 module does.
- Resolving a conflict no longer fails when a memory's conflict list is damaged; the other side is still cleaned.
