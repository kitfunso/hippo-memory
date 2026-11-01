### Fixed

- **`hippo promote`, `hippo share`, `hippo sync`, `hippo learn`, `hippo remember`, `hippo watch` and capture wait for the embeds they start before they return.** The command's store runtime now keeps that work and settles it before it closes, so it no longer closes under a running embed. A process run of these commands already waited, because Node stays up for a pending embed; the change shows where `runCli` resolves.
- **`serve()` and `hippo serve` no longer lose the global vector of a memory promoted just before `stop()`.** `stop()` now waits up to 5 seconds for the embeds a request started, logs how many still run at that bound, and then closes the stores.
- **`hippo mcp` waits for the embeds its tool calls started before it exits when stdin closes.** It exited once the calls in flight answered, which cut off the embed of a row `hippo_share` had copied to the global store. One 5 second bound now covers the calls and then that work, and a warning names how many tasks still run at the bound.

### Changed

- **`sleep` on the package root resolves after the embeds of the rows its auto-share copies, unless the `Context` sets the new optional `detached` keeper.** `detached` takes an object whose `detach(work)` keeps each promise it is handed; settle them before you close the store. Its type, `DetachedWork`, is exported from the package root, `hippo-memory/server` and the `entry/sleep` and `entry/eval-scripts` entries.
