### Fixed

- **Capture no longer stores a rule cut inside a bold label or an aside.** Capture now removes bold pairs and keeps a bracket whole before it splits sentences. A line such as `- **Volume data.** Never backfill them.` now stores "Never backfill them", not "** Never backfill them". Capture removes only real `**` pairs, read by the CommonMark rules, so `**kwargs`, `2**10`, `**/*.ts` and code spans keep their text. A line whose bold markers capture used to keep is not stored a second time.
- **The next daily run or `hippo sleep` sets the cut rows you already have aside once.** This includes stored rows that start with `** `. The run takes a backup first, keeps pinned rows, and prints the "N look doubtful and were kept" notice once more. `hippo audit repair` lists those rows. Bring one back with `hippo dormant restore <id>`.

### Known limitations

- Repair misses some cuts, and a missed cut stays stored as before. Four shapes pass. One is a text cut inside a code span, where the first backtick closes the span. One is a cut word of 3 letters or fewer before `)`. One is a `**` cut that a later bold pair follows. One is a cut right after a word, for example `sleep** (when`. On the global store measured for this fix, 65 of 76 cut rows are set aside. Eight misses are cuts right after a word. One miss is the code-span case. Two misses are merged rows with no automatic parent, which `hippo audit repair` lists for review.
- An old row that starts with an unclosed `**` stays as it is. Capture stores no clean copy beside it.
- Repair reads only the text of a row. A rare valid row can be set aside, for example one with a quoted `test)`. Bring it back with `hippo dormant restore <id>`.
- The upgrade notice counts only the rows it moved or listed for review. A pinned cut row stays, and the notice does not name it. `hippo audit repair` shows it.
