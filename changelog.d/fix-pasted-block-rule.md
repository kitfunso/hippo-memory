### Fixed

- **A pasted block no longer becomes your rule.** Since 3.2.0, capture treats a statement in your reply as your rule. It also read text you pasted into that reply, so a line from a pasted runbook or log could be pinned as a rule you stated, with the paste's tags in its text. Capture now skips `<pasted_content>` blocks. A row that an earlier capture stored this way stays until you remove it with `hippo forget`.
