### Changed

- **Internal:** the GitHub and Slack dead-letter stores now share one naming scheme, every `Github` identifier is spelled `GitHub`, and the GitHub CLI verb moved from `src/connectors/github/cli-impl.ts` to `src/cli/github.ts`. No behaviour change.
