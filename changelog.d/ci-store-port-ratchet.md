### Documentation

- **A CI ratchet now counts what is left of the store port.** `scripts/check-store-port.mjs` tracks database openers outside the data layer, store branches in `src/api`, routes without `storeReady` and twin functions; none may rise above `.store-port-baseline.json`. No runtime change.
