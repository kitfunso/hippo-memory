### Documentation

- **Test suite hygiene.** Schema-version assertions read the version from `src/db.ts` through one shared helper, the type-only API contract test and a stale skipped test are replaced or removed, the envelope migration test is renamed for what it checks, and `hippo eval --suite`, the postinstall script and an upgrade from a v1 store gain behaviour tests. No product change.
