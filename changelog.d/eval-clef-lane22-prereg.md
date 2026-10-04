### Changed

- **`scripts/rerank-3arm-ab.mjs` can run a hosted CLEF comparison inside the Workers AI free allocation.** `RERANK_HIPPO_ROOT` points it at a frozen store copy, `RERANK_MAX_CALLS` caps the calls in one run, and `RERANK_CACHE_DIR` keeps each answer so the next run resumes; no verdict prints until every query is scored. The run also reports its input tokens. `docs/EXPERIMENT-PROTOCOL.md` pre-registers Lane 22, clef-flash against the local cross-encoder.
