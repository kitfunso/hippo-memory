### Changed

- **Internal:** the session-end workflow moved from `src/cli/session-hooks.ts` to `sessionEndWork` in `src/api/session-end.ts`; the CLI passes in its sleep, capture and log steps. The vector codec (`float32ToBuffer`, `bufferToFloat32`, still exported, now from `hippo-memory/store-kit`) moved to `src/util/vector-codec.ts`, and `initializeParticle` to `src/core/physics.ts`. No behaviour changes.
