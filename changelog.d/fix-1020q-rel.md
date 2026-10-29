### Fixed

- **A server writes its request trail with no `HIPPO_LOG` set.** The access line, the 4xx line, the MCP 4xx tool line and the late-finish line used to need `HIPPO_LOG=info`. `HIPPO_LOG=warn` still turns them off, and CLI and hook output is unchanged.
- **Hook log files carry the error class, stack and cause of each failure.** The pre-compact and session-end logs held the message only.
- **A store worker or dashboard reader reply that cannot be posted fails its call.** Before, a call with no deadline waited forever.
- **The Anthropic client retries a reset connection or a timed-out attempt**, as it retries a 5xx.
- **A thrown value that is not an `Error` logs a short, secret-masked preview** as `value=`.
