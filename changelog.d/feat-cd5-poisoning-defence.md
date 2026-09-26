### Added

- **A quarantine tier for connector-ingested memory.** `hippo quarantine [list|approve|reject]` and
  `GET/POST /v1/quarantine` let an admin review a memory a connector flagged as a possible prompt
  injection before it rejoins active memory.

### Security

- **GitHub and Slack connector text is screened for prompt injection before it becomes a memory.**
  A conservative detector (`src/instruction-detect.ts`) catches instruction-override, role
  reassignment, chat-role markup, concealment, remote-script-exec and exfiltration shapes; a flagged
  row is stored under a restricted `quarantine:private:*` scope instead of its normal scope, so
  default recall, `hippo_context` and the hook never surface it until an admin approves it.
  CLI/HTTP/MCP `remember` and local single-user mode are unaffected.
- **A quarantined row can no longer be shared to the global store**, even with `--force` or by
  sleep auto-share, and it takes no part in conflict detection, so it cannot mark a visible memory as conflicted.
