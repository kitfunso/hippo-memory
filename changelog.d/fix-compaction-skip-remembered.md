### Fixed

- **A compaction no longer saves a lesson the agent already saved with `hippo remember`.** The PreCompact instruction now asks the summariser to leave those out of its "Memories for hippo" list. On one real store, all 8 near-duplicate pairs between compaction memories and other memories were of this kind: the agent saved a lesson, and the next compaction listed it again in new words, which the word-for-word copy check rightly does not treat as a copy.
