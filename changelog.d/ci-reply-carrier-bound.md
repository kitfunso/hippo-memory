### Documentation

- **The sync-or-async reply carrier is stated and bounded.** `docs/ARCHITECTURE.md` explains why a few published functions return a value or a Promise, and `scripts/check-store-port.mjs` now stops `andThen` and `onStore` spreading to new files. No runtime change.
