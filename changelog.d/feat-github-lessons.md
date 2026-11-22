### Added

- **A revert commit and a CODEOWNERS change on the default branch each become a memory with a link to the commit.** Subscribe the GitHub webhook to Pushes and each revert in a push gives one lesson, with a link to the original commit or pull request when the message names one. `hippo github backfill --lessons` reads default-branch commits for reverts and CODEOWNERS changes, from `--since` on every run, else from the last 30 days, and the token needs Contents read. A parked push replays with `hippo github dlq replay`.
