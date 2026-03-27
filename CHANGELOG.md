# Changelog

## 0.8.0 (2026-03-27)

### Added
- Multi-agent shared memory: `hippo share <id>` shares memories with attribution and transfer scoring. Memories tagged with universal patterns (error, platform, gotcha) score higher for sharing; project-specific ones (config, deploy, file-path) are filtered out.
- `hippo share --auto` auto-shares all high-scoring memories. `--dry-run` previews candidates.
- `hippo peers` lists all projects contributing to the global store with memory counts.
- `transferScore()` exported for programmatic transfer quality estimation.
- Conflict resolution CLI: `hippo resolve <id> --keep <mem_id> [--forget]`.

### Changed
- `hippo resolve` without `--keep` now shows both conflicting memories for comparison.
- Version bumped to 0.8.0 across all manifests.

## 0.7.0 (2026-03-27)

### Added
- Hybrid search: `hippo recall` and `hippo context` now blend BM25 keyword scores with cosine embedding similarity when `@xenova/transformers` is installed. Falls back to pure BM25 otherwise.
- `SearchResult.cosine` field on all search results (0 when embeddings not used).
- `searchBothHybrid()` async function for cross-store (local + global) hybrid search.
- Schema acceleration: `schema_fit` is now auto-computed from tag + content overlap against existing memories. High-fit memories (>0.7) get 1.5x half-life; novel memories (<0.3) get 0.5x.
- `computeSchemaFit()` exported for programmatic use.
- Agent evaluation benchmark: 50-task sequential learning eval comparing no memory, static memory, and hippo. Validates the learning-over-time hypothesis (78% early trap rate -> 14% late).
- `tests/hybrid-search.test.ts`, `tests/agent-eval.test.ts`, `tests/schema-fit.test.ts`.

### Changed
- `hippo recall`, `hippo context`, and MCP tools (`hippo_recall`, `hippo_context`) upgraded from synchronous BM25-only search to async hybrid search.
- MCP server request handling is now async to support embedding pipeline.
- `hippo remember`, `hippo learn --git`, and `hippo watch` now auto-compute schema_fit instead of defaulting to 0.5.

## 0.6.3 (2026-03-21)

### Fixed
- `hippo learn --git` now distinguishes between "not a git repo" and "real repo with no commits in the lookback window", so multi-repo learn reports the correct status instead of false `No git history found` messages.
- Synced release metadata across package, OpenClaw plugin manifests, and MCP server version reporting.

## 0.6.2 (2026-03-19)

### Added
- `hippo-memory` now exposes root-level OpenClaw package metadata and a root plugin manifest, so `openclaw plugins install hippo-memory` works directly from npm.
- Added an OpenClaw npm-install smoke test script to verify the packed tarball can be installed into an isolated OpenClaw state directory.

### Fixed
- Normalized the published CLI `bin` entry to avoid npm auto-correct warnings during publish.

## 0.6.1 (2026-03-19)

### Added
- OpenClaw plugin package is now included in the npm tarball so npm installs carry the integration files as well as the CLI.

### Changed
- OpenClaw plugin now resolves Hippo from the active workspace instead of arbitrary process cwd, preserving the intended local `.hippo/` plus global `~/.hippo/` lookup model.
- OpenClaw plugin `autoLearn` and `autoSleep` config now map to real hook behavior, including failed-tool capture and session-end consolidation.
- Release metadata is aligned across package, MCP server, lockfile, and OpenClaw plugin manifests.

## 0.5.1 (2026-03-15)

### Added
- `hippo init` now auto-creates a daily cron job (6:15am) for `hippo learn --git --days 1 && hippo sleep`. Cross-platform: crontab on Linux/macOS, Task Scheduler on Windows. Use `--no-schedule` to skip.

## 0.5.0 (2026-03-15)

### Added
- Configurable `defaultHalfLifeDays` in `.hippo/config.json` (default: 7). Adjust for teams that code in bursts.
- Configurable `defaultBudget` (4000) and `defaultContextBudget` (3000) for recall and context commands.
- Auto-sleep: triggers `hippo sleep` after 50 new memories in 24 hours. Configure via `autoSleep.enabled` and `autoSleep.threshold`.
- Configurable `gitLearnPatterns` array for `hippo learn --git`. Default now includes: fix, revert, bug, error, hotfix, bugfix, refactor, perf, chore, breaking, deprecate.

### Changed
- Embeddings default to `"auto"`: uses `@xenova/transformers` if installed, falls back to BM25 silently.
- MCP server refactored to use programmatic API directly (no child process spawning). 10x faster tool calls.
- Git learn patterns broadened: now catches refactor, perf, chore, breaking, and deprecate commits in addition to fix/revert/bug.
- Default context budget raised from 1500 to 3000 for main sessions.

## 0.4.1 (2026-03-15)

### Added
- `hippo mcp` command: MCP server over stdio transport. Works with Cursor, Windsurf, Cline, Claude Desktop, and any MCP-compatible client.
- MCP server exposes 6 tools: hippo_recall, hippo_remember, hippo_outcome, hippo_context, hippo_status, hippo_learn.

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
