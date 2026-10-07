### Added

- **`HIPPO_HEALTH_PROBE_MS` sets how long the CLI waits for a running `hippo serve` to answer.** The CLI checks that the server is alive before it sends a write there, and gives up after 300 ms. On a busy machine a slow answer made the CLI skip the server and write to the store directly. Set a larger value, such as 5000, to give the server more time. Zero, a negative number or text that is not a number keeps the 300 ms default.
