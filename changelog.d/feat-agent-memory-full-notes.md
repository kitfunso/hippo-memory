### Fixed

- **An agent note longer than 1,500 characters is now stored in full.** The import used to cut it at the cap, so its tail was never recalled. Now it splits the note into parts at its headings and paragraphs. Each part starts with the note's name and heading, and an edit changes only the part it touches. This holds for all six agents.
- **A secret in a long note refuses only the part that holds it.** The strict secret check runs on the whole note before the split, and a key block or code block is never cut in the middle.
- **The global store now imports the notes Claude Code keeps for the home folder.** `hippo sleep`, `hippo init` and `hippo import --agents --global` used to skip them. The import takes over the rows the old Claude import wrote for those notes, so each note has one live row. A second run keeps every row live.
- **A note that grows past the cap keeps its history.** Its first part takes the recall and outcome counts of the row it replaces. A note cut back under the cap gets one row that replaces all its parts, and nothing is set aside.
- **An imported row that a decision or another object links to stays live when its note goes.** It loses its tag, as a pinned row does, so the link holds. Before, the row went dormant and the link was lost.

### Changed

- **The agent-memory summary line counts notes the store already holds.** For example: "Agent memories: 1 already stored."
