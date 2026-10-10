### Changed

- **Internal:** The test-only export check no longer counts a name in a `src/` comment as a production use. The 16 exports this exposed are resolved at the source: dead duplicates are deleted in favour of their production twins, module-private helpers lose `export`, and their tests now run through the public entry points.
