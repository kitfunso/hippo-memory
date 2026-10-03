### Changed

- **Memories saved at a compaction now fade like any other memory.** 1.53.0 kept them for good, so a long session that compacted many times built up rows that sleep could never retire. They now decay, go dormant and get deduped like the rest of the store. Imported agent memories are still kept, because the agent's own note file is their record.
- **A compaction item that restates a memory the project already holds is skipped.** When another session restates it, that memory is strengthened as if it were recalled. The old repeat check matched exact text only, so a reworded lesson was saved again each time. An item counts as a restatement when it is the held memory with words left out, in the same order, keeping every number and every "not", "never", "only", "unless" and the like, and is at least half its length. A changed or swapped number or word, or a dropped "not" or "only", is saved as new. Private and quarantined memories that recall hides never absorb an item. The log now reads `skipped N item(s) the store already holds`.

### Fixed

- **Sleep, dedupe and `hippo audit --fix` no longer delete a memory that backs a decision, incident, prediction, process, policy, skill, project brief or customer note.** Deleting one cleared the object's link, and no restore could repair it. The audit now reports such a row as a warning ("backs an object") instead of an error. `hippo forget` still deletes it when you ask.
