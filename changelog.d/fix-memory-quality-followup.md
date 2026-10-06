### Fixed

- **Session capture reads each turn on its own.** A code fence or spec heading left open in one turn no longer swallows the next one, and a statement two turns repeat is stored once.
- **Capture follows Markdown fence rules.** A line that starts with three backticks and closes them on the same line is inline code, a fence closes only on a bare run at least as long as the one that opened it, and `~~~` fences and fences opened inside list items count too. Inline code and "e.g.", "i.e.", "vs." and "cf." no longer end a sentence, including at the end of a line.
- **A wrapped line joins the line above only when that line has not ended its sentence.** Spec bullets keep their wrapped lines, and a spec bullet that asks a question is skipped.
- **The quality check only judges what hippo wrote itself, by where a memory came from rather than its tags alone.** Capture, git learning, sleep merges, compaction memories, extracted facts and DAG summaries are judged. A person's memory, a lesson from a failed command and a verified memory never are, so sleep merges, extracts from and shares them whatever their wording. A tag such as `captured` marks hippo's text only on a promoted or shared copy, so a note imported from a "## Captured" heading is never judged.
- **Sleep and auto-share never reuse an automatic memory with a certain defect.** A sentence that may be cut off ("When CI fails we retry once") is stored and listed for review instead of being refused. A merged bundle is judged by the memories it holds, so it is held back only when every one of them has a certain defect, and `hippo audit` flags it only when every one has a defect.
- **A log line stays out even when it says "after" or "because".** A timestamp or log-level lead now needs a rule word such as "never" to count as a memory; an error name followed by a reason still counts.
- **A 4-space line under a sentence or list item continues it.** After a blank line or a heading it is read as indented code.
- **`hippo audit repair --apply` sets aside a derived bundle only when every part has a certain defect and every parent is automatic.** Anything less is listed for review. Superseded and archived rows are skipped, and the backup is deleted when the repair fails; a backup that cannot be deleted no longer hides why.
- **A memory restored from an audit repair comes back verified,** so later repairs leave it alone. Other restored memories keep their confidence.
- **A busy store gives a plain message instead of a stack trace** when another hippo process holds the write lock.

### Documentation

- **`hippo audit repair` help and output name the restore command.** `--apply --global` prints the restore command with `--global`. CONTEXT.md defines "automatic memory" and lists every reason a memory goes dormant.
