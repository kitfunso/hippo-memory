### Changed

- **Sixteen long functions across 14 `src/` modules are split into smaller helpers, with no change in behaviour.** They include `serve`, `detectServer`, `rejectValue`, `detectChurnStale`, `createDeliveryRecorder`, `buildSyntheticCorpus`, `runDoctor`, `autoShare` and `searchBothHybrid`. Each one is now 63 lines or fewer, and their entries are gone from `.size-baseline.json`. A new test pins the synthetic eval corpus.
