### Changed

- **Every icon and share-card mark is now built from one file, `website/public/logo.svg`.** `website/scripts/make-images.mjs` reads the mark from it and writes `favicon.svg`, `favicon-48.png`, `apple-touch-icon.png` and the cards in `website/public/og/`, so a new icon means replacing that file and rerunning the script. The cards now carry the pixel hippo and each page's current title.
- **npm and PyPI keywords follow the site.** `rag` and `hybrid-search` are gone from `package.json`, `open-source` is new, and the Python SDK lists agent-memory terms in place of `rag`.

### Documentation

- **The README, the plugin READMEs, the integration docs and the Python SDK README now use hippo-memory.com's words and numbers.** The README opens with the home page's install, the seven steps of one memory, the repeat-mistakes result and the public memory tests. Its Benchmarks section has the same numbers and split as /benchmarks: official-setup rows beside the published ones, and our own setup apart. Numbers the site no longer shows, the neuroscience section and the claude-mem tables are gone.
- **Docs that were wrong are fixed.** `integrations/generic.md` lists all 13 MCP tools and says the store is SQLite with markdown mirrors, `integrations/cursor.md` adds the `.cursor/mcp.json` step and the rules import, and the Claude Code docs say to use the plugin or the hooks, not both. The Python SDK README says to run `hippo serve --port 3737`, the port the SDK uses by default.
- **`docs/product-facts.md` now names the website as the owner of public wording,** describes the default prompt context as pinned rules plus up to five memories that share the prompt's words, and adds the repeat-mistakes and model-call claims with their limits.
