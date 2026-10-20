### Fixed

- **Working memory now evicts the oldest of equal entries.** Past its per-scope cap, working memory drops the lowest-importance entry, oldest first. Two entries written in the same millisecond had the same `created_at`, so SQLite could drop the newer one. The eviction and the read now break that tie by insertion order, as goal suspension, DLQ lists and DAG child reads also do now.
