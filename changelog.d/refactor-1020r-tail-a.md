### Fixed

- **`hippo import` finishes embedding the rows it imported, or warns that it could not, before it exits.** The backfill used to run on after the command had closed its store, so its vectors or its warning could be lost.
- **`hippo promote`, `hippo share`, `hippo sync`, `hippo learn` and capture embed the rows they copy before the command's store runtime closes.** Each embed used to run on after the command returned. The runtime now keeps that work and settles it as the command ends, and `serve()` settles a request's embeds in `stop()` before it closes the store.

### Changed

- **`sleep` and `captureSessionTexts` resolve after the embeds they start, unless the `Context` sets the new optional `detached` keeper.** See docs/UPGRADING-3.0.md.
