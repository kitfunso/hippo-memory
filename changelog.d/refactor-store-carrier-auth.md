### Changed

- **An unwritable audit log now fails `hippo auth create` and `hippo auth revoke` instead of being skipped.** The key write and its audit row commit together with or without a served store, so a failed audit write leaves no new key and leaves the key being revoked live. `authCreate` and `authRevoke` on a context with no store throw the same error.
- **An unwritable audit log now fails `hippo auth grant` and `hippo auth ungrant` too.** The grant change and its audit row commit together, and the key is checked under the write lock, so a failed audit write leaves the grants as they were.
- **Each key operation has one implementation.** `authCreate`, `authCreateSelf`, `authList`, `authListRows` and `authRevoke` run one body on the served store or on hippo.db, through the new `onStore` carrier in `src/api/on-store.ts`. Exported names and signatures are unchanged.
