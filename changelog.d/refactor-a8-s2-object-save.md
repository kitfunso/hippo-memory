### Changed

- **Decisions and project briefs share one save and supersede.** Internal refactor: `src/objects/lifecycle.ts` now holds the write half (preflight, insert, supersede, audit rows and the mirror memory) and each type describes its columns and audit keys as data; `src/objects/fields.ts` holds the two field checks. Function names, signatures, error text, stored rows, mirror memories and audit rows are unchanged. Policies, customer notes, processes and skills follow.
