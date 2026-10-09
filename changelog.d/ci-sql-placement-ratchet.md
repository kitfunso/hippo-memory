### Documentation

- **The store-port ratchet now counts SQL written outside the data layer.** `scripts/check-store-port.mjs` adds `sqlOutside` (with a per-file map) and `txLiterals`, and fails when `const V1_ROUTES` is missing. No runtime change.
