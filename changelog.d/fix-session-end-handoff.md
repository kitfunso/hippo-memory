### Fixed

- **A session that ends without compacting now gets a handoff.** The session-end handoff came only from the snapshot hippo saves when Claude Code compacts, so a session that never compacted ended with none. hippo now builds one from the end of the session's own transcript: the last request, a summary and the last reply, with secrets scrubbed. A resumed session that ends again gets a new handoff from its transcript. A handoff written with `hippo handoff create`, or the session's own snapshot, still wins.
