### Changed

- **Test files named s to z, digits and underscore, plus every tests/ subfolder, now type-check.** Fixtures use the real `Context`, `ChannelMeta`, `RerankResult` and `Response` shapes, and `createMemory` calls go through `tests/_helpers/create-memory.ts` so each one passes a half-life. Two tests passed arguments the code ignored (`deleteEntry` tenant, `remember` layer); both are corrected. No runtime or CLI change.
