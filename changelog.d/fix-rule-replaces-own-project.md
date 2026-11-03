### Fixed

- **A rule replaces a stored preference only in that preference's own project.** In a shared store, a capture with no project stamps its rule with no project, and that rule could supersede a named project's preference, so the project lost the row from its context. A rule now replaces a row only when the row belongs to one of the rule's project names. Any other copy stops the rule, as before.
