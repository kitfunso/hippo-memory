### Fixed

- **A text flag given with no value now fails instead of storing the word "true".** `hippo snapshot save --summary`, `hippo handoff create --next`, `hippo remember --scope` and the other text flags in the CLI exit 1 with `--<flag> requires a value`, and nothing is written.
- **Internal:** every CLI flag read goes through the helpers in `src/cli/flag-values.ts`, and `scripts/check-cli-flags.mjs` fails CI on a hand-rolled `String(flags[...])`.
