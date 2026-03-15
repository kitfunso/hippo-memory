# Changelog

## 0.4.0 (2026-03-15)

### Added
- `hippo init` auto-detects agent frameworks (Claude Code, Codex, Cursor, OpenClaw) and installs hooks automatically. Use `--no-hooks` to skip.
- `hippo learn --git --repos <paths>` scans multiple repos in one pass (comma-separated paths).
- Codex integration guide (`integrations/codex.md`).
- CHANGELOG.md with full version history.

### Changed
- README rewritten with auto-hook install docs, multi-repo learn section, and updated comparison table.
- PLAN.md updated with shipped feature status.
- All integration guides updated for auto-install workflow.

## 0.3.1 (2026-03-15)

### Added
- `hippo init` auto-detects agent frameworks (Claude Code, Codex, Cursor, OpenClaw) and installs hooks automatically. Use `--no-hooks` to skip.
- `hippo learn --git --repos <paths>` scans multiple repos in one pass (comma-separated paths).
- Codex integration guide (`integrations/codex.md`).

### Changed
- README rewritten with auto-hook install docs, multi-repo learn section, and updated comparison table.
- OpenClaw integration guide updated with auto-install instructions and multi-repo cron example.

## 0.3.0 (2026-03-13)

### Added
- Cross-tool import: `hippo import --chatgpt`, `--claude`, `--cursor`, `--markdown`, `--file`.
- Conversation capture: `hippo capture --stdin` / `--file` (pattern-based, no LLM).
- Confidence tiers: `--verified`, `--observed`, `--inferred`. Auto-stale after 30 days.
- Observation framing: `hippo context --framing observe|suggest|assert`.
- All import commands support `--dry-run`, `--global`, `--tag`.
- Duplicate detection on import.

## 0.2.0 (2026-03-10)

### Added
- `hippo learn --git` scans recent commits for fix/revert/bug lessons.
- `hippo watch "<command>"` auto-learns from command failures.
- `hippo context --auto` smart context injection (auto-detects task from git).
- `hippo embed` optional embedding support via `@xenova/transformers`.
- `hippo promote` and `hippo sync` for local/global memory management.
- Framework hooks: `hippo hook install claude-code|codex|cursor|openclaw`.

## 0.1.0 (2026-03-01)

### Added
- Core memory system: buffer, episodic, semantic stores.
- `hippo init`, `hippo remember`, `hippo recall`, `hippo sleep`.
- Decay by default (7-day half-life).
- Retrieval strengthening (+2 days per recall).
- Error tagging (2x half-life).
- Outcome feedback (`hippo outcome --good/--bad`).
- Token budgets on recall.
- BM25 search (zero dependencies).
- Markdown + YAML frontmatter storage.
- Global store support (`~/.hippo/`).
