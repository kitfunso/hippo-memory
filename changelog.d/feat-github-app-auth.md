### Added

- **`hippo github backfill` can sign in as a GitHub App.** Set `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY_FILE`, and optionally `GITHUB_APP_INSTALLATION_ID`. Hippo mints a one-hour installation token limited to the repository and replaces it before it expires, so a long run no longer stops at the hour mark. The key is read from the file only and never from env. A fully set App wins over `GITHUB_TOKEN`. Outer whitespace on `GITHUB_TOKEN` is trimmed.
- The GitHub webhook route and `hippo github dlq replay` make no GitHub API call, so they need no token.

### Changed

- **A reply that is not JSON no longer carries the parser's message.** That message can quote part of the reply, so an error or a log line could show a secret the server echoed.
- **`GITHUB_TOKEN` must use only the GitHub token characters.** Those are letters, digits, `_`, `.` and `-`; any other character exits 2 with a fixed text that does not repeat the value.
- **A GitHub error or broken reply that echoes the token shows `[token]` in place of any 8-character piece of it, and its cause keeps no reply bytes.** A next-page link that holds a piece of the token is refused before it is followed, and the error names only the request's own host and path.
