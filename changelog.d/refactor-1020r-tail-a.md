### Fixed

- **`hippo import` waits for its embedding backfill, and reports a failed one, before it returns.** The command, and a caller that runs it in process through `runCli`, used to get control back while the backfill still ran, and the command's store runtime closed under it.
- **`hippo promote`, `hippo share`, `hippo sync`, `hippo learn` and capture wait for the embeds of the rows they copy before they return.** The command's store runtime now keeps that work and settles it before it closes, so it no longer closes under a running embed, and `serve()` settles a request's embeds in `stop()` before it closes the store.

### Changed

- **`sleep` and `captureSessionTexts` resolve after the embeds they start, unless the `Context` sets the new optional `detached` keeper.** See docs/UPGRADING-3.0.md.
