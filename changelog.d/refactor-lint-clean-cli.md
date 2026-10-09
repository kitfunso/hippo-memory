### Changed

- **Internal:** The CLI code has 68 fewer old lint hits, and the whole-repo count falls from 91 to 23. Casts now carry a `SAFETY:` line or are gone, named guards replace `typeof` checks, and optional JSON keys are set in the same order as before. No command output changes.

### Fixed

- **A hook that cannot start its delivery recorder now logs through the leveled logger.** The skip line was the one delivery-ledger message left outside it, so `HIPPO_LOG` and `HIPPO_LOG_FORMAT=json` did not apply. It now reads `[hippo] warn: delivery ledger skipped: <reason>`, with a space after the colon.
