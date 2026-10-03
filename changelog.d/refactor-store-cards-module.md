### Changed

- **Moved the work-queue card functions out of `store.ts` into `src/store-cards.ts`.** The package entry exports the same names. Deep imports of `createCard`, `loadCard`, `claimCard` and the other card functions from `dist/store.js` must point at `dist/store-cards.js`.
