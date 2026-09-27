### Fixed

- **SessionEnd capture keeps whole sentences instead of keyword-anchored fragments.** The automatic memory pulled at session end now stores a complete, subject-bearing sentence (with its reason clause when there is one), capped at 3 per session, instead of a truncated snippet that could start mid-clause or drop the subject entirely. Manual `hippo capture --stdin`/`--file` is unchanged.
