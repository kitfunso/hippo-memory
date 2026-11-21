### Added

- **Each `latest` release now publishes the VS Code extension.** A new `vscode-publish.yml` job runs after the npm publish. It packages `extensions/vscode` and publishes it to Open VSX and the VS Code Marketplace, so both stores get each release without a hand upload. A store whose token secret (`OVSX_PAT` or `VSCE_PAT`) is not set is skipped with a warning. Backport releases skip this job, so they never replace a newer listing.
