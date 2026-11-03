### Fixed

- **A model call that thinks first no longer comes back empty.** The Anthropic adapter read only the first block of a reply. A thinking model puts a thinking block first, so the reply text was lost and the call counted as empty. The adapter now reads the first text block.
