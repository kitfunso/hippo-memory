### Fixed

- **The MCP stdio fault tests wait for the child process to flush its error stream.** One case could read the stream before the warning arrived and fail by chance. Internal only, no runtime behaviour changes.
