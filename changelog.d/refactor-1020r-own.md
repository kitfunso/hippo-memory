### Changed

- **The MCP status tool, `hippo inspect`, the PreCompact hook and the connector dead letters now read and write through `src/api`, and the CLI keeps no command state in module variables.** Commands, flags and printed output stay the same, with one exception: the PreCompact twin-fire check now reads the store's clock, so it honours `HIPPO_FAKE_NOW`. With a fake time set, a second preCompact fire within 10 seconds of the first is now skipped, as it already was with the real clock.
- A remote caller's PreCompact now runs the same store steps as the local hook. Two of its server warnings now use the local hook's wording: "snapshot save failed" and "stored snapshot unreadable, saving the derived one alone".
