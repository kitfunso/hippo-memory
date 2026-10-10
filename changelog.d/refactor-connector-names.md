### Changed

- **Internal:** the GitHub and Slack dead-letter stores now share one naming scheme, every `Github` identifier is spelled `GitHub`, and the GitHub CLI verb moved from `src/connectors/github/cli-impl.ts` to `src/cli/github.ts`. No behaviour change.

### Fixed

- **`hippo github` takes its tenant from the dispatcher.** Backfill and the DLQ verbs now use the same tenant the other verbs use (`HIPPO_TENANT`, else default); the value is the same one they resolved before, so nothing changes for users.
