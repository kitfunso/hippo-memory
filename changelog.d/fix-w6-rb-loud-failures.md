### Fixed
- **Failed auth is logged by default.** A 401 or 403 now writes a warn line with the request id; other 4xx stay at info.
- **MCP errors are logged.** A busy store logs at warn and a typed non-500 at info, both with the tool name.
- **Judge and consolidation failures are visible.** Non-2xx and transport errors from the capture judge log at warn with status or error class; the sleep LLM passes record the error class and stack.
- **The OpenCode plugin reports a failed hook.** A non-zero `hippo session-end` or `last-sleep` writes one line with the exit code to stderr; the hook stays non-fatal.
