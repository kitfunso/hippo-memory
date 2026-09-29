### Changed

- **The CLI tests run this checkout's own `bin/hippo.js`, found from the test file.** They used to resolve it from the working directory, so a run started from any other folder failed, and a run from another worktree tested that worktree's build.
