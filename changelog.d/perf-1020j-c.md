### Changed

- **Capture dedup and `hippo learn --git` read only the copies of their texts.** They looked up each text's longest word and read every row holding it, all of the tenant's rows when the full-text index could not name the word or was out of sync. A batch now reads one query per 500 texts and gets back only rows equal to a text apart from spacing, plus sleep-merged rows holding one. A store built on `store-kit` takes whole texts in `captures.textsHolding` and `lessonWrites.textsHolding`, which replaces `textsHoldingWords`; see `docs/UPGRADING-3.0.md`.
