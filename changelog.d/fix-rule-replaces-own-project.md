### Fixed

- **A rule replaces a stored preference only in that preference's own project.** In a shared store, a capture with no project stamps its rule with no project, and that rule could supersede a named project's preference, so the project lost the row from its context. Capture now works out the project a rule is written for once: the project you name, or else the store folder's project with its older names. A shared or user-global store gives none. A rule replaces a row only when the row belongs to that project, and a dry run reports the same skip the write makes.
