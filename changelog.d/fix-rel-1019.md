### Fixed

- **The stdio MCP server exits cleanly when its client hangs up mid-reply.** A broken stdout pipe used to crash it with an unhandled stream error; it now exits 0 and logs other stdout errors before exiting 1.
- **Stats counters no longer lose increments when the store is busy.** A refused increment is kept per store and added to the next update.
- **`hippo` CLI errors flush stderr before the process exits.** The exit code is unchanged; the last error lines are no longer cut off.
