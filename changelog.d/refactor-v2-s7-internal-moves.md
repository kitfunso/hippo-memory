### Changed

- **Internal:** the session-end workflow moved from `src/cli/session-hooks.ts` to `sessionEndWork` in `src/api/session-end.ts`; the CLI passes in its sleep, capture and log steps. The vector codec (`float32ToBuffer`, `bufferToFloat32`, still exported from `hippo-memory/server`) moved to `src/util/vector-codec.ts`, and `initializeParticle` to `src/core/physics.ts`. Core no longer reads `HIPPO_LOSS_AVERSION_RATIO`: `src/api/loss-aversion.ts` reads it and `calculateStrength` takes an optional `lossAversionRatio`. No behaviour changes.
