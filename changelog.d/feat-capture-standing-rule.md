### Changed

- **Capture pins a rule only when a person states a standing rule.** A person's narration ("it always marked the override as off") and one-off requests ("please fix it and make sure the tests pass") are still stored, but no longer pinned.
- **Capture now reads a correction as a rule.** A person's reply that opens with No, Yes, Right, Correct, Wrong or Not quite and gives a `because` reason ("No: run the linter first, because CI fails without it.") is captured and pinned, even when it holds no keyword like "always" or "never". Agent text extracts as before.
