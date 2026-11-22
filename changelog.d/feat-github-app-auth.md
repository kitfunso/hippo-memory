### Added

- **`hippo github backfill` can sign in as a GitHub App.** Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`, and optionally `GITHUB_APP_INSTALLATION_ID`. Hippo mints a one-hour installation token limited to the repository and replaces it before it expires, so a long run no longer stops at the hour mark. The key is read from the file only and never from env. A fully set App wins over `GITHUB_TOKEN`.
- The GitHub webhook route and `hippo github dlq replay` make no GitHub API call, so they need no token.
