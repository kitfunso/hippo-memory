### Fixed

- **`hippo import` finishes embedding the rows it imported, or warns that it could not, before it exits.** The backfill used to run on after the command had closed its store, so its vectors or its warning could be lost.
