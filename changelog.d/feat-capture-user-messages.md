### Added

- **Session capture saves each message you type.** The session-end hook stores each message of 3 or more words whole, as a `kind='raw'` row tagged `user-message`, so a fact told in chat comes back through recall in a later session. Secrets and email addresses are masked first, a long paste keeps only your own words, and the agent's replies are never saved. Only the project's own store gets them; they stay out of the prompt hook's recent list, have no markdown mirror and are never shared. Turn it off with `{"capture": {"userMessages": false}}`.

### Fixed

- **A tool-failure lesson now gets a vector.** The `PostToolUseFailure` hook embeds the lesson it stores, so recall by meaning finds it, not only recall by words.
