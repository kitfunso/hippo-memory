### Fixed

- **Error logs in catch blocks now carry the error class and stack.** Twelve more `log.error` calls (auto-sleep, daily runner, summary rebuild, dashboard, db open, mirror cleanup, recall trace, quarantine) pass the same fields the rest of the repo logs.
- **A damaged `steps` column on a process now warns.** It still reads back as no steps, but the log names the table, row and column, as the `linked_memory_ids` column already does.
- **A read that fails inside a snapshot keeps its own error.** If the closing commit also failed, the caller used to see the commit error instead of the read error.
