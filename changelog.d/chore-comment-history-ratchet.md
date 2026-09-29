### Changed

- **CI now stops comments that carry ticket codes, version tags, reviewer notes or dates from growing.** `scripts/check-comment-history.mjs` counts them per file in `src/` against `.comment-history-baseline.json` and fails a PR that raises a count; no source file changed, and later PRs rewrite the existing 1,538 lines.
