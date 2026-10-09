### Changed

- Internal: sleep, dedup and the half-life migration no longer open `hippo.db` themselves. The chunked flush, dormant expiry, rescue audit rows, tombstone checks, dedup deletes and the half-life move call store functions that own the handle; behaviour is unchanged.
