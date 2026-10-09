### Changed

- **The layer order is now enforced in CI.** `layers.json` maps every `src/` folder and root file to one of six layers, and `scripts/check-layers.mjs` fails when a file imports from a higher layer than its own. Existing upward imports are frozen in `.layers-baseline.json` and can only shrink. No runtime behaviour changes.
