### Added

- **hippo now saves memories at every Claude Code compaction.** Before the summary is written, the PreCompact hook asks the summariser to end it with a "Memories for hippo" list of the lessons, decisions and corrections from the session. After compaction, the PostCompact hook saves each item as a memory, up to 10 per compaction, and prints one line, such as "Hippo saved 3 memories from this compaction and restored your task snapshot." Items an earlier compaction already saved, and items that look like secrets, are skipped.
- **Memories saved at a compaction are kept for good.** Sleep never deletes them, moves them to dormant or merges them, and never sends them to fact extraction; `hippo forget` and `hippo supersede` still work on them. The session that compacted does not have them injected back into its own prompts. An older hippo running `hippo sleep` on the same store does not know this rule.
- **Every compaction leaves a record, and a busy store no longer loses the save.** A new `compactions` table (schema 49) holds the summary with secrets scrubbed and the list. If the store is locked, the summary waits in a spool folder and `hippo sleep` finishes it, along with any compaction whose hook was killed. `hippo doctor` gains a `compactions` line that names one left unfinished for over 10 minutes.

### Fixed

- **`hippo supersede` keeps the old memory's project and session.** It dropped them, so in the global store every superseded project memory turned user-global.
