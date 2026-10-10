### Changed

- **Internal:** store modules now open a handle through `onHandle` instead of hand-written open/try/finally/close blocks, and `predictions.ts` keeps its prediction column list in one constant.
