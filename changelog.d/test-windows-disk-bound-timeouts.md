### Fixed

- **Five store-heavy test files no longer time out on a slow Windows runner.** Three seed loops now write through one connection, and each file states its own time limit, so a slow disk no longer fails the suite.
