# Changelog

## 0.20.0 (2026-04-12)

### Added
- **`hippo dedup` command.** Scans the store for near-duplicate memories (default: 70% Jaccard overlap), keeps the stronger copy, removes the weaker. Shows clear reasoning: count by type (redundant semantic patterns, duplicate episodic lessons, cross-layer duplicates), similarity percentage, and content preview for each pair. Supports `--dry-run` and `--threshold <n>`.
- **Auto-dedup on sleep.** `hippo sleep` now runs dedup after consolidation with a categorized summary of what was removed and why.
- **MEMORY.md import on init and sleep.** `hippo init` and `hippo sleep` scan Claude Code memory files (`~/.claude/projects/<project>/memory/*.md`) and import new entries with deduplication against existing memories.

### Fixed
- **Windows CRLF in MEMORY.md frontmatter.** Frontmatter regex now handles `\r\n` line endings.

## 0.19.1 (2026-04-09)

### Fixed
- **Configured embedding model propagation.** `hippo embed`, hybrid search, and physics search now all respect `embeddings.model` from `config.json` instead of silently falling back to the default model.
- **Stale embedding index on model change.** Switching `embeddings.model` now forces a full embedding rebuild and physics-state reset so query vectors and cached vectors stay compatible.
- **Model-specific pipeline caching.** Embedding pipeline instances are now cached per model instead of being reused across different configured models.
- **Version metadata drift.** Synced package, plugin, MCP server, and dashboard version strings for the 0.19.1 release.

## 0.19.0 (2026-04-08)

### Added
- **Pi coding agent extension.** Native extension at `extensions/pi-extension/` with automatic context injection, error capture (noise filtered + rate limited + deduped), session-end consolidation, and 5 registered tools (hippo_recall, hippo_remember, hippo_outcome, hippo_status, hippo_context).
- `hippo hook install pi` patches AGENTS.md with hippo instructions.
- Pi auto-detected during `hippo init` when `.pi/` directory exists.

## 0.18.0 (2026-04-08)

### Added
- **Multi-project auto-discovery.** `hippo init --scan [dir]` finds all git repos under a directory (default: home, max 2 levels deep) and initializes each one with a `.hippo/` store. Seeds with a full year of git history by default. Also initializes the global store. Use `--days <n>` to control history depth, `--no-learn` to skip git seeding.

## 0.17.0 (2026-04-08)

### Added
- **Auto-share to global on sleep.** `hippo sleep` now promotes high-transfer-score memories (>= 0.6) to the global store after consolidation. Universal lessons (error patterns, tool gotchas) are shared; project-specific memories (file paths, deploy configs) are filtered out. Content dedup prevents duplicates. Configurable via `autoShareOnSleep` in config (default: true). Skip with `--no-share`.

## 0.16.2 (2026-04-08)

### Fixed
- **OpenClaw plugin registers once.** Added module-level guard to prevent repeated tool registration on WebSocket reconnection. Previously, every reconnect attempt re-registered all 10 tools.

## 0.16.1 (2026-04-08)

### Changed
- **`deduplicateLesson` performance.** Accepts pre-loaded `MemoryEntry[]` instead of reloading from disk on every iteration. Eliminates N redundant `loadAllEntries` calls during `hippo learn --git`.

## 0.16.0 (2026-04-08)

### Added
- **Auto-learn from git on init.** `hippo init` now seeds the store with 30 days of git history on first setup. New users get instant memory from their commit history. Skip with `--no-learn`.
- **Auto-learn from git on sleep.** `hippo sleep` now runs `learn --git --days 1` before consolidation, capturing recent commit lessons automatically. Configurable via `autoLearnOnSleep` in config (default: true). Skip with `--no-learn`.

## 0.15.0 (2026-04-08)

### Added
- **Adaptive decay for intermittent agents.** Memories now decay based on how often the agent runs, not just wall-clock time. An agent that runs weekly gets 7x longer half-lives automatically. Three modes available via `decayBasis` in config:
  - `"adaptive"` (default) — auto-scales half-life by average session interval. Daily agents behave identically to before. Weekly agents keep memories ~7x longer.
  - `"session"` — decay by sleep cycle count instead of days. Each `hippo sleep` = 1 "day" in the decay formula. Best for agents with unpredictable schedules.
  - `"clock"` — classic wall-clock decay (previous default behavior).
- `SessionDecayContext` and `loadSessionDecayContext()` exported for programmatic use.
- Sleep counter tracked in meta table, incremented on each consolidation run.

## 0.14.0 (2026-04-08)

### Added
- **Automatic backup cleanup on OpenClaw boot.** The plugin now removes stale `hippo-memory.bak-*` directories from `~/.openclaw/extensions/` at registration time. These leftovers from plugin updates cause duplicate plugin ID errors on next boot.

## 0.13.3 (2026-04-08)

### Fixed
- **`rebuildIndex` ROLLBACK safety.** Wrapped in try-catch to prevent masking the original error if BEGIN fails.
- **MCP bare `require` replaced.** `child_process` now imported at top level instead of dynamic `require()` inside ESM module.
- **MCP notification protocol compliance.** All unknown `notifications/*` methods return null (no response), preventing malformed JSON-RPC responses with `id: undefined`.
- **Dead code in `calculateStrength`.** Removed unreachable `entry.pinned` check (pinned entries return early before reaching the guard).
- **Embedding atomic write cleanup.** `.tmp` file is deleted if `renameSync` fails.
- **`HIPPO_HOME` whitespace rejection.** Environment variables are trimmed before use, preventing whitespace-only values from being treated as valid paths.
- **Autolearn env var regex.** Now handles lowercase env vars (`node_env=prod cmd`). `fetchGitLog` uses `execFileSync` to avoid shell interpolation.

## 0.13.2 (2026-04-08)

### Fixed
- **Windows schtasks `%` expansion.** Schedule setup now rejects paths containing `%` on Windows, preventing environment variable injection in Task Scheduler commands. Also fixed quote escaping from `\"` to `""` (correct for `schtasks /tr`).
- **MCP `conflict_id: 0` rejected.** The `!conflictId` check treated ID `0` as invalid due to JavaScript's `!0 === true`. Now uses `isNaN()`.
- **MCP swallowed async errors.** Failed tool executions now send a JSON-RPC error response instead of silently dropping, preventing clients from hanging.
- **Cross-store budget loop inconsistency.** `searchBoth` and `searchBothHybrid` now always include the first result regardless of budget, matching the fix applied to `search.ts` in v0.13.0.
- **Autolearn env var regex false positives.** Regex anchored to only strip leading `KEY=val` assignments, no longer matching `--ARG=val` mid-command.
- **`bufferToFloat32` crash on corrupt data.** Returns empty array for buffers not divisible by 4 bytes instead of throwing.
- **`embedAll` race condition.** Now uses the same `withEmbedLock` mutex as `embedMemory`, preventing concurrent read-modify-write on `embeddings.json`.

## 0.13.1 (2026-04-08)

### Reverted
- **Physics simulation behavior changes.** Reverted co-location perturbation, position collapse reset, and repulsion direction changes from v0.13.0. These need local validation before shipping. The `velocityAlignmentBonus` NaN guard and `Float32Array` alignment fix are kept (pure safety, no behavior change).

## 0.13.0 (2026-04-08)

### Fixed
- **SECURITY: Command injection in OpenClaw plugin.** `runHippo` now uses `execFileSync` with an args array instead of shell string interpolation. All 15 call sites converted. Tag, ID, and session key parameters are no longer injectable.
- **MCP server Content-Length byte/char mismatch.** Incoming message parser now works with raw Buffers instead of decoded strings, correctly handling multi-byte Unicode characters.
- **NaN propagation in `calculateStrength`.** Added guards for zero `half_life_days` and NaN-safe clamping. Memory IDs now use `crypto.randomUUID` for stronger entropy.
- **Token budget drops top result.** Search now always includes the first (highest-ranked) result regardless of budget, then applies budget logic for subsequent results.
- **Non-atomic embedding writes.** `saveEmbeddingIndex` now writes to a temp file then renames. Added mutex to serialize concurrent `embedMemory` calls.
- **FTS5/LIKE query injection.** Search terms are now properly quoted for FTS5 and escaped for LIKE metacharacters.
- **Physics simulation edge cases.** Zero-magnitude query embeddings guarded against NaN. Co-located particles get random perturbation. Position collapse resets to random unit vector. Float32Array alignment ensured.
- **MCP server swallows all exceptions.** `uncaughtException` and `unhandledRejection` now log to stderr instead of silently swallowing.
- **Recursive DB open in `appendSessionEvent`.** Session event count query now reuses the existing connection.
- **Legacy import not transactional.** `rebuildIndex` legacy import loop now wrapped in BEGIN/COMMIT.
- **Shell injection in schedule setup.** `projectDir` validated for unsafe characters before interpolation into crontab/schtasks.
- **Cross-store dedup ineffective.** Search dedup now uses content hash instead of ID (local/global IDs differ after promote/share).
- **Autolearn stores secrets.** Environment variable assignments are stripped from command text before storing error memories.
- **Silent config parse failure.** Broken `config.json` now warns to stderr instead of silently falling back to defaults.
- **Import truncation silent.** Memories truncated during import now produce a warning.
- **Cached pipeline failure permanent.** Failed embedding pipeline load no longer permanently prevents retries.
- **MCP `notifications/initialized` response.** Notifications no longer receive a JSON-RPC response (protocol compliance).

## 0.12.0 (2026-04-08)

### Added
- **Configurable global store location.** The global Hippo store now respects `$HIPPO_HOME`, then `$XDG_DATA_HOME/hippo`, falling back to `~/.hippo/`. Set `HIPPO_HOME=/path/to/hippo` to keep your home directory clean. Works across CLI, MCP server, and OpenClaw plugin. Closes #5.

## 0.11.2 (2026-04-08)

### Fixed
- **Cross-platform path handling in OpenClaw plugin.** `resolveHippoCwd()` now uses `path/posix` after normalizing backslashes, so Windows-style paths like `C:\repo\.hippo` are correctly parsed on Unix systems. Previously, `path.basename` on Unix treated backslashes as valid filename characters, causing `.hippo` detection to fail. Closes #6.

## 0.11.1 (2026-04-07)

### Fixed
- **OpenClaw plugin: error capture filtering.** The `autoLearn` hook now filters tool errors before storing them as memories. Three filters prevent memory pollution: a noise pattern filter (skips known transient errors like browser timeouts, `ECONNREFUSED`, image path restrictions, `Navigation timeout`), a per-session rate limit (max 5 error memories), and per-session deduplication (same error from same tool captured only once). Previously, every tool failure was stored, causing up to 78% of all memories to be garbage error noise that consolidation then amplified into hundreds of synthetic semantic memories.
- **Orphaned embedding pruning.** `hippo embed` now removes cached vectors for memories that no longer exist. Previously, embedding vectors accumulated indefinitely after memory deletion. `hippo status` and `hippo embed --status` now show orphan counts with a prune hint.

## 0.10.0 (2026-04-07)

### Added
- **Active invalidation**: `hippo learn --git` detects migration/breaking commits and actively weakens memories referencing the old pattern. Manual invalidation via `hippo invalidate "<pattern>"`.
- **Architectural decisions**: `hippo decide` stores one-off decisions with 90-day half-life and verified confidence. Supports `--context` for reasoning and `--supersedes` to chain decisions.
- 1.2x recall boost for decision-tagged memories so they surface despite low retrieval frequency.
- **Path-based memory triggers**: Memories auto-tagged with `path:<segment>` from cwd on creation. Recall boosts memories matching the current directory (up to 1.3x). Works for remember, decide, and learn --git.
- **OpenCode integration**: `hippo hook install opencode` patches AGENTS.md. Auto-detection via `.opencode/` or `opencode.json`. Integration guide with MCP server config and `.opencode/skills/memory/` skill.
- `hippo export [file]` exports all memories as JSON or markdown.
- HippoRAG paper reference added to RESEARCH.md and README.md.

## 0.9.1 (2026-04-06)

### Added
- `hippo hook install claude-code` now also installs a Stop hook in `~/.claude/settings.json` that runs `hippo sleep` automatically when Claude Code exits. No more forgetting to consolidate.
- `hippo init` auto-installs the Stop hook when Claude Code is detected.
- `hippo hook uninstall claude-code` cleanly removes the Stop hook from settings.json.

## 0.8.0 (2026-03-27)

### Added
- Multi-agent shared memory: `hippo share <id>` shares memories with attribution and transfer scoring. Memories tagged with universal patterns (error, platform, gotcha) score higher for sharing; project-specific ones (config, deploy, file-path) are filtered out.
- `hippo share --auto` auto-shares all high-scoring memories. `--dry-run` previews candidates.
- `hippo peers` lists all projects contributing to the global store with memory counts.
- `transferScore()` exported for programmatic transfer quality estimation.
- Conflict resolution CLI: `hippo resolve <id> --keep <mem_id> [--forget]`.
- `hippo dashboard` — local web UI at localhost:3333 with memory health overview, strength distribution chart, conflict management, peer status, and searchable/filterable memory table.
- MCP server: added `hippo_conflicts`, `hippo_resolve`, `hippo_share`, `hippo_peers` tools (10 total).
- OpenClaw plugin: added same 4 tools (9 total).

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
