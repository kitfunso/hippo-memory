### Changed

- **A release tag now publishes to npm only after the whole CI workflow passes on the tagged commit.** `npm-publish.yml` calls `ci.yml` and the publish job waits for it, so a red Windows, macOS, Node-floor or coverage job stops the release. Before, a tag published after one Ubuntu run of the release gate.
- **Nine tests no longer fail on a slow runner.** Their upper bounds on elapsed time are now counts of statements, lock waits and pauses, or a ratio against a baseline timed in the same run. The offline `HIPPO_MODEL_CACHE` test now runs in the CI job that has the model, and fails there when the model folder is missing. No runtime behaviour changes.
