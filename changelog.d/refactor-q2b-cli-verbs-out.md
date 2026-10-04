### Changed

- **Every remaining CLI verb lives in a domain module under `src/cli/`, and `src/cli.ts` is now only the entry point and command table.** The command table loads each module only when one of its verbs runs, and the help text moved to `src/cli/usage.ts`. `src/cli.ts` drops from 7,937 to 678 lines and no file under `src/cli/` is over 800. The code moved as written, so output, flags, help text and exit codes are unchanged.
