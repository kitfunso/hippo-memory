### Fixed

- **`hippo import --cursor .cursor/rules` imports the folder instead of failing with EISDIR.** The README and `hippo --help` said the command takes `.cursor/rules`, but the Cursor importer only read a single file, so pointing it at the folder where current Cursor keeps its rules crashed. It now imports every `.mdc` and `.md` file in that folder and its subfolders, drops each rule's front matter (Cursor's `description`, `globs` and `alwaysApply` settings) so it no longer lands as a junk memory, and still reads a single `.cursorrules` file as before.
