### Changed

- **Internal:** `hippo remember` and `hippo watch` now run one shared local write pipeline in the api (`rememberLocally`: schema fit, the salience gate, the write, the read-back, the `remembered` counter and the embedding), and `hippo remember` asks the api for fact extraction (`extractRememberedFacts`). Stored rows, counters, printed lines and exit codes are unchanged; a new spawned-CLI test pins them.
