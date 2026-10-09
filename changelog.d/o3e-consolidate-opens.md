### Changed

- Internal: sleep and dedup no longer open `hippo.db` themselves. The chunked flush, dormant expiry, rescue audit rows, tombstone checks and dedup deletes call store functions that own the handle; behaviour is unchanged.
