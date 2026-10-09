### Changed

- **Internal:** six embedding tests (lifecycle-stress, global-row-embeddings) now report as skipped, not passed, when the local embedding backend is missing, and the micro-eval CI job runs them with `HIPPO_REQUIRE_EMBEDDINGS=1` so a missing backend there fails.
