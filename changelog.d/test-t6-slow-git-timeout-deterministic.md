### Tests

- **Two tests that failed on a loaded or older-Node Windows machine are deterministic.** The slow-git test proves the `timeoutMs` cap by outcome (a wide cap reads the tree behind a 3 s hook, a 300 ms cap gives null) with no elapsed-time check, and the shared-store symlink test removes its link with `unlinkSync`, which works on a junction on every Node 24 build.
