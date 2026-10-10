### Changed
- `hippo status` skips the all-pairs physics energy above 2000 particles and prints `energy: skipped (<n> particles)`.
- `hippo provenance` and `hippo correction-latency` read only the rows their report needs instead of every memory.
- **Internal:** the sleep conflict refresh reads only rows that hold conflicts or are named, and the physics force loop accumulates in place instead of allocating per pair.
