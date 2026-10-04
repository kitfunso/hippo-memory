### Changed

- **CI now stops long files and long functions in `src/` from growing.** `scripts/check-size-ratchet.mjs` parses every `src/` file with the TypeScript compiler and fails a PR that adds a file over 800 lines or a function over 80, or grows one already listed in `.size-baseline.json`. No source file changed; later PRs split the existing offenders.
