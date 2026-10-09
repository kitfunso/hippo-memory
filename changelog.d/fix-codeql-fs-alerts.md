### Fixed

- **Hippo reads a file through the same open handle it checked.** Agent memory files, session transcripts, a `.git` worktree file and log tails in a support bundle were sized or tested by path and then opened again by path; a file swapped in between could be read past the size cap or as the wrong kind. Results for ordinary files are unchanged.
- **A FIFO in an agent memory folder is skipped as "not a file" straight away** instead of being able to hold the import waiting for a writer.
- **The pre-compact diagnostic log checks its size on the handle it writes through.** It still starts again once it passes 256 KB. Two hooks logging in the same instant can now overwrite one diagnostic line.
- **`hippo eval --suite` reads its baseline in one step.** A missing baseline is still silent and an unusable one still warns.
