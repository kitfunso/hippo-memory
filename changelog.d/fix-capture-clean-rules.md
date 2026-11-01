### Fixed

- **Capture no longer stores a rule cut inside a bold label or an aside.** A line such as `- **Volume data.** Never backfill them.` now stores "Never backfill them", not "** Never backfill them". The extractor removes only real `**` pairs, read by the CommonMark rules, so `**kwargs`, `2**10`, `**/*.ts` and code spans keep their text. A text that still starts after the closing `**` of a bold span, after a bare `**`, or after the `)` of an aside is refused as a sentence fragment. A line whose bold markers capture used to keep is not stored a second time.
- **The next daily run or `hippo sleep` sets the cut rows you already have aside once.** This includes stored rows that start with `** `. The run takes a backup first, keeps pinned rows, and prints the "N look doubtful and were kept" notice once more. `hippo audit repair` lists those rows. Bring one back with `hippo dormant restore <id>`.

### Known limitations

- The checks miss some cuts, and a missed cut stays stored as before. A `)` right after a code span, a cut word of 3 letters or fewer before `)`, and a `**` cut that a later bold pair follows all pass. On the global store measured for this fix, 72 of 76 cut rows are set aside. One is the code-span case. Three are merged rows with no automatic parent, which `hippo audit repair` lists for review.
- The upgrade notice counts only the rows it moved or listed for review. A pinned cut row stays, and the notice does not name it. `hippo audit repair` shows it.
