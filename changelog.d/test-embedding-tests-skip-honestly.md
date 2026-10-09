### Changed

- **Internal:** six embedding tests (lifecycle-stress, global-row-embeddings) now report as skipped, not passed, when the local embedding backend is missing, and the micro-eval CI job runs them with `HIPPO_REQUIRE_EMBEDDINGS=1` so a missing backend there fails.

### Fixed

- **The local embedder now loads its optional package with a plain dynamic import.** It also loads inside test runners that execute modules in a VM, where the old Function-built import failed with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
