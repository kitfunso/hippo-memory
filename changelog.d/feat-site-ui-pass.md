### Fixed

- **The website keeps the space between a word and a link or inline code.** 34 places on 10 pages read like "theMCP server page", because Astro 7 changed its HTML compression default. The site now sets `compressHTML: true`.

### Changed

- **The website has no eyebrows, captions or taglines.** Each heading and its content carry the section, so a page shows less text.
- **Command blocks that are safe to paste whole have a copy button.** They are on the quickstart, Claude Code, Codex, Cursor and MCP pages. Example blocks have none, so one press never runs a sample command.
- **Every section of the website has a stable id.** A person or an agent can link to one section. Links that stand alone have a 24px tap area, and motion uses two durations.
- **The website build guards itself.** `npm run build` in `website/` fails on a word glued to a link, a duplicate id, a `DESIGN.md` colour the code does not use, or visible text that differs from `website/text-snapshot/`. A `Website` workflow runs it on pull requests that touch `website/` or `README.md`. `website/AGENTS.md` lists the rules for agents.
