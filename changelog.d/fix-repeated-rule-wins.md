### Fixed

- **A preference you repeat in a reply is now stored as your rule.** When the opening request said "Use `pnpm` instead of `npm`" and a later reply said it again, capture kept the plain preference from the request, so the rule never printed at session start. In one capture the rule copy now wins. In a later `--turn` capture the rule replaces the stored preference row, which is marked superseded. A pinned row, a row you typed, a row with no project, or an older copy that kept its `**` marks still stops a second copy.
