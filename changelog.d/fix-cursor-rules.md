### Fixed

- **Cursor's hippo block now goes to `AGENTS.md`, which Cursor reads.** hippo wrote it to `.cursorrules`, which Cursor's rules docs no longer mention; they describe `.cursor/rules` and a root `AGENTS.md`. `hippo hook install cursor` now patches `AGENTS.md`, and `hippo init` no longer touches `.cursorrules`: a Cursor project gets the block through its existing `AGENTS.md`, and init still never creates that file. `hippo hook uninstall cursor` removes the block from `AGENTS.md` and an old one from `.cursorrules`, and deletes a `.cursorrules` that held nothing else.
