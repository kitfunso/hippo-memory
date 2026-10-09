### Changed

- **Long functions in the CLI are split into named steps.** Thirty-two functions in `src/cli.ts` and `src/cli/` that ran past 50 lines are cut into smaller same-file helpers. Output, exit codes and side-effect order are unchanged.
