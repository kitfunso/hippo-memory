### Fixed

- **`serve()` and `hippo serve` no longer lose the global vector of a memory promoted just before `stop()`.** `stop()` resolved about 24 ms after a `POST /v1/memories/:id/promote`, the embed then failed with "the store is closed", and the global copy never got its vector. `stop()` now waits up to 5 seconds for the embeds a request started, logs how many still run at that bound, and then closes the stores.
- **`hippo mcp` waits for the embeds its tool calls started before it exits when stdin closes.** It exited once the calls in flight answered, which cut off the embed of a row `hippo_share` had copied to the global store. One 5 second bound now covers the calls and then that work, and a warning names how many tasks still run at the bound.
- **`hippo import` waits for its embedding backfill, and reports a failed one, before it returns.** The command, and a caller that runs it in process through `runCli`, used to get control back while the backfill still ran, and the command's store runtime closed under it.
- **`hippo promote`, `hippo share`, `hippo sync`, `hippo learn`, `hippo remember`, `hippo watch` and capture wait for the embeds they start before they return.** The command's store runtime now keeps that work and settles it before it closes, so it no longer closes under a running embed. A process run of these commands already waited, because Node stays up for a pending embed; the change shows where `runCli` resolves.

### Changed

- **`sleep` on the package root resolves after the embeds of the rows its auto-share copies, unless the `Context` sets the new optional `detached` keeper.** Its type, `DetachedWork`, is exported from the package root and `hippo-memory/server`. See docs/UPGRADING-3.0.md.
