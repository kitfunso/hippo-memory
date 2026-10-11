### Changed

- **Sleep's physics pass moves at most 1000 particles.** Each substep compares every particle with every other, so a large store made one sleep take minutes. Past the cap, sleep moves the 1000 most recently recalled memories and leaves the rest as stored; the details line says how many it picked. Stores under the cap get the same results as before.
- **An MCP remember that starts an auto-sleep inside `hippo serve` runs the consolidation in a child process.** It shares the queue and deadline of `POST /v1/sleep`, so the server keeps answering while it runs. Stdio MCP still consolidates in its own process.

### Fixed

- **A sleep whose rescue audit cannot open the store now logs a warning with the error class.** It was a debug line, so the missing audit rows went unnoticed.
- **Internal:** the auto-share threshold is one named constant shared by sleep, `hippo share --auto` and `autoShare`.
