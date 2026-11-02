### Fixed

- **Capture no longer stores a rule cut inside a bold label or an aside.** Capture now removes bold pairs and splits sentences where 3.1.0 did, and skips a sentence that starts inside an aside the split cut. A line such as `- **Volume data.** Never backfill them.` now stores "Never backfill them", not "** Never backfill them". Capture removes only real `**` pairs, read by the CommonMark rules, so `**kwargs`, `2**10`, `**/*.ts` and code spans keep their text. A line whose bold markers capture used to keep is not stored a second time.
- **The next daily run or `hippo sleep` sets the cut rows you already have aside once.** This includes stored rows that start with `** `. The run takes a backup first, keeps pinned rows, and prints the "N look doubtful and were kept" notice once more. `hippo audit repair` lists those rows. Bring one back with `hippo dormant restore <id>`.

### Known limitations

- Repair misses some cuts, and a missed cut stays stored as before. Four shapes pass. One is a text cut inside a code span, where the first backtick closes the span. One is a cut word of 3 letters or fewer before `)`. One is a `**` cut that a later bold pair follows. One is a cut right after a word, for example `sleep** (when`. On the global store measured for this fix, 65 of 76 cut rows are set aside. Eight misses are cuts right after a word. One miss is the code-span case. Two misses are merged rows with no automatic parent, which `hippo audit repair` lists for review.
- A code span that wraps onto a line that starts with a capital letter can split the rule, as in 3.1.0.
- Capture skips only the sentence that starts inside a cut aside. The text before the cut stays as 3.1.0 stored it, for example `Always run the check (see the docs`.
- Capture skips a whole rule that follows a cut aside directly, as in `main) Never push on Friday`. The skip removes it with the cut.
- An unclosed `(` earlier in a block can make capture skip a later rule that holds a quoted `)`.
- Capture reads `**` by the Markdown rules. Two power operators in one line, such as `(n + 1)**2 and 2**-1`, read as a bold pair and lose their `**`.
- Capture no longer refuses a text that arrives already cut, such as `done.** then always run the tests`. It stores that text as 3.1.0 did. Only the one-time repair sets such rows aside.
- Repair reads only the text of a row. A rare valid row can be set aside, for example one with a quoted `test)`. Bring it back with `hippo dormant restore <id>`.
- The upgrade notice counts only the rows it moved or listed for review. A pinned cut row stays, and the notice does not name it. `hippo audit repair` shows it.
