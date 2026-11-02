### Added

- **The prompt hook and `hippo context` print the rules you stated first, as plain instructions.** A row that capture marked as your own rule now prints under `## Rules from the user`, ahead of the task snapshot and the memories, as `- <the rule>`. It has no confidence tag, no "Previously observed" date, no tags and no strength, so it no longer reads as an old note. It prints once, not again under Project Memory or Prompt-Relevant Memory. Every other row prints as before, and a block with no such rule is byte for byte the block 3.1.1 prints. The token budget pays for the new heading only when the block holds such a rule. JSON output is unchanged.
- **A row counts as your rule only for the project and tenant that captured it.** It must be pinned, come from capture, carry the `from-user` tag, have confidence `observed` and no scope, and not be superseded. A global view, another project or tenant, and a legacy row with no project print as before.

### Changed

- **A tag you type can no longer set `from-user`.** `hippo remember`, `hippo supersede`, `hippo trace`, `hippo import`, the MCP `hippo_remember` tool and the HTTP write drop that tag, so only capture can mark a row as your rule. A supersede of such a row drops the tag from the new row, which is already set to `verified`. `hippo pin` changes no tags.
