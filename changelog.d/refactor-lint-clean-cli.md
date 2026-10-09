### Changed

- **Internal:** The CLI code has 68 fewer old lint hits, and the whole-repo count falls from 91 to 23. Casts now carry a `SAFETY:` line or are gone, named guards replace `typeof` checks, and optional JSON keys are set in the same order as before. No command output changes.
