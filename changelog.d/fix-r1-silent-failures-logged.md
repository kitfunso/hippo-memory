### Fixed
- Embedding failures now warn once per distinct provider and error, not once per process, so a later different failure is no longer hidden.
- Outbound HTTP retries, an unexpected failure in the heartbeat auth check, a skipped heartbeat tick, an unreadable `config.json`, an unexpected repo-scan error, a failed capture log append and an uncountable table now leave a log line.
- **Internal:** unreadable embedding error bodies and config reads log at debug or warn, damaged dormant snapshots warn, and the graph page script reports an unparseable model on the console.
