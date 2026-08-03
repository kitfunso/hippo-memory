# CS1: PreCompact capture + compact-aware re-injection

Status: Draft (plan-eng-critic pending)
Episode: 01KZ3W3DS3CF5HAZ69NWT654EC
Source: ROADMAP.md Part IV "CS1" (lines 1038-1049); AutoCompact follow-up.

## Problem

Compaction summarizes the session; working state (ids, decisions, the next step) can drop out of the summary. `hippo setup` installs only SessionEnd + SessionStart + UserPromptSubmit hooks today (`src/hooks.ts:662-790`). Mid-session compaction is a blind spot: nothing captures state before the summary is written, and nothing re-injects it after.

## Verified contract (code.claude.com/docs/en/hooks, re-read 2026-08-03)

- PreCompact stdin JSON: `{session_id, transcript_path, cwd, hook_event_name}`; matchers `manual` | `auto`.
- **Exit code 2 on PreCompact BLOCKS compaction.** Hard invariant for this feature: the producer verb exits 0 on every path. PreCompact stdout is NOT injected into context.
- SessionStart supports matcher `"compact"`, and its stdout IS injected as context the model can see.
- Hook `timeout` field is in seconds; existing hippo entries use `timeout: 5`.

## Existing machinery reused (no new storage, no migration)

- `task_snapshots` table + `saveActiveTaskSnapshot(hippoRoot, tenantId, {task, summary, next_step, source?, session_id?, scope?})` (`src/store.ts:2017`), `loadActiveTaskSnapshot`, `printActiveTaskSnapshot`.
- `src/capture.ts`: `resolveLastSessionTranscript` (already reads `transcript_path` from hook stdin JSON, line 356-366), `summariseTranscript`, `extractFromText`, and the `cmdCapture` dedup path.
- Marker-guarded additive hook installer pattern (`installJsonHooks`, `src/hooks.ts:662-790`).

## Design

### T1 — producer verb: `hippo pre-compact` (new case in `src/cli.ts`, logic in `src/capture.ts`)

- Read hook stdin JSON. Transcript resolution (**amended at verify stage, 2026-08-03**): when the payload carries a `transcript_path`, that path is EXCLUSIVE — if it is missing or unreadable, skip with a log line, never fall back. Newest-transcript auto-discovery applies ONLY when no payload path exists (manual invocation). Rationale: the verify-stage E2E drive proved the fallback snapshots a DIFFERENT session's newest transcript under the payload's session_id when the given path is unreadable — cross-session contamination with wrong linkage. The original "payload first, --last-session fallback" wording was the plan's own defect.
- **Tail cap**: parse only the last `PRE_COMPACT_TAIL_BYTES = 256 * 1024` bytes of the transcript via a **positional read** (`fs.openSync` + `fs.readSync` at `size - cap` — never read-whole-file-then-slice; PreCompact fires exactly when transcripts are largest). Align forward to the first complete JSONL line after the seek point.
- Produce two outputs from the tail, **in this order, each in its own try/catch** (critic round 1):
  1. FIRST: a `TaskSnapshot` via `saveActiveTaskSnapshot`: `task` derived from the most recent plain-text user message, `summary` from `summariseTranscript(tail)`, `next_step` from the last assistant text block, `source: 'pre-compact'`, `session_id` from the payload. **Field caps (task 200 chars, summary 2000, next_step 500) are enforced in the pre-compact producer ONLY** — the shared `saveActiveTaskSnapshot` and the existing `hippo snapshot save` CLI path are untouched (AGENTS.md public-API preservation). The caps protect the re-injection token budget (audit rule 9).
  2. SECOND: standard capture extraction over the tail so durable items land as memories. Existing capture dedup absorbs overlap with the later SessionEnd capture. Snapshot-first ordering means a capture failure can never lose the headline artifact; a lost capture self-heals at SessionEnd (loss window below).
- **Skip rule**: if the tail yields an empty summary and no extracted items, write nothing — never clobber a user-authored active snapshot with junk. Otherwise overwrite: the pre-compact state is the newest truth, and `source: 'pre-compact'` marks provenance.
- **Exit-0 invariant**: entire body inside try/catch; every path ends `process.exit(0)`. Malformed stdin, missing transcript, unwritable store — all exit 0 (loss window accepted below). Outcome lines APPEND to a dedicated `~/.hippo/logs/pre-compact.log` (`--log-file` overridable) — NOT the session-end log file, which `cmdSleep` truncates at every SessionEnd, so pre-compact lines written there would be wiped before anyone read them (critic round 1). Purely diagnostic; no consumer reads it.
- Tenant/scope resolution identical to `cmdSnapshot`/`cmdCapture` defaults (hooks run with cwd = project dir, same as `session-end` today).

### T2 — injector verb: `hippo compact-resume` (new case in `src/cli.ts`)

- Reads the SessionStart stdin payload. If it parses and carries `source !== 'compact'`, exit 0 with no output — defence in depth so the matcher is an optimization, not a dependency (older Claude Code that ignores the matcher just runs a silent no-op on normal starts).
- **Same exit-0/crash-safety contract as T1** (critic round 2): entire body in try/catch, every path exits 0; a malformed payload or a throw from `loadActiveTaskSnapshot`/`listSessionEvents` degrades to empty stdout, never a non-zero exit (a failing SessionStart hook must not pollute session startup). T4 test 3 gains a malformed-payload + store-error case.
- Otherwise print to stdout (SessionStart stdout is injected directly; plain markdown like the existing `last-sleep` output):
  - A `## Restored after compaction` header.
  - The active task snapshot (task / summary / next step / session id), whatever its `source` — it IS the current working state.
  - The last few session events for the snapshot's session via `listSessionEvents(hippoRoot, tenantId, {session_id, limit})` (`src/store.ts:2191`, default limit 8) — reuse the default.
- No pinned memories here — `UserPromptSubmit` pinned-inject already re-injects those every turn; duplicating them doubles token cost for nothing.
- Output budget: snapshot field caps (T1) keep this block ~<1200 tokens.

### T3 — installer wiring (`src/hooks.ts` + `src/cli.ts` printers)

- New markers: `HIPPO_PRE_COMPACT_MARKER = 'hippo pre-compact'`, `HIPPO_COMPACT_RESUME_MARKER = 'hippo compact-resume'`.
- `installJsonHooks` additions (marker-guarded, additive, same shape as siblings):
  - `PreCompact`: `{hooks: [{type: 'command', command: 'hippo pre-compact --log-file "<logFile>"', timeout: 30}]}` — no matcher; runs on manual AND auto compaction.
  - `SessionStart`: `{matcher: 'compact', hooks: [{type: 'command', command: 'hippo compact-resume', timeout: 10}]}` — a SECOND SessionStart entry alongside the existing un-matched `last-sleep` entry; marker check keys on the command string so idempotency is preserved.
- **Matcher-overlap decision (critic round 1)**: the existing `last-sleep` entry has no matcher, so it ALSO fires on a compact SessionStart. Accepted, documented behavior: mid-session, the session-end log was already consumed at startup, so `last-sleep` prints nothing in the common case; in the rare case another session's SessionEnd wrote the shared log in between, its consolidation block surfaces at this compaction instead of at the next startup — same content, earlier, benign. Rewriting the installed `last-sleep` entry to exclude `compact` would force a settings migration on every existing install to suppress a harmless informational block; rejected on proportionality. T4 adds a combined-firing test (both commands run against the same store/log state) so the interaction is characterized, not assumed.
- `InstallResult` gains `installedPreCompact` + `installedCompactResume` (additive). Update every consumer surface (audit rules 2/5 enumeration): the parse-failure early-return object (`hooks.ts:672-683`), the final return, `uninstallJsonHooks` (remove both entries), the three `cli.ts` printer sites (612, 6482, 6609), and the fourth consumer `installClaudeCodeSessionEndHook` (`cli.ts:6722-6731`, currently dead code — its boolean OR keeps compiling with additive fields; extend the OR to include the new fields for consistency, no behavior change).
- `hippo setup` help text + README hook table gain the two new entries.

### T4 — tests

- `tests/hooks.test.ts`: fresh install adds both new entries; second run adds neither (idempotency); parse-failure object carries the new fields as false; uninstall removes both; legacy-migration behavior unchanged.
- New `tests/pre-compact-e2e.test.ts` (real store, scratch `HIPPO_HOME` + tmp cwd — never a repo checkout [PROBATION: feedback_hippo_probe_scratch_stores]):
  1. Synthetic transcript `.jsonl` fixture → run the built CLI `hippo pre-compact` with a simulated PreCompact stdin payload → assert exit 0, `task_snapshots` row with `source='pre-compact'` + payload session_id, extracted memories present.
  2. Missing transcript path / malformed stdin / empty transcript → exit 0 every time, no snapshot written (exit-0 invariant + skip rule).
  3. `hippo compact-resume` with SessionStart `source:'compact'` payload → stdout contains the snapshot task + next step; with `source:'startup'` → empty stdout, exit 0.
  4. Field caps: oversized synthetic messages → stored fields respect 200/2000/500 caps via the producer; `hippo snapshot save` with oversized text still stores uncapped (shared function untouched).
  5. Combined-firing (matcher overlap): run `hippo last-sleep` then `hippo compact-resume` against the same store — with no pending session-end log, last-sleep is silent and the compact-resume block is intact; with a pending log, both blocks print and neither corrupts the other.

## Loss windows (audit rule 12, enumerated up front)

- PreCompact verb crash → exit 0, no snapshot → SessionStart(compact) adds nothing → degraded to status quo. Accepted, self-healing (next compaction retries).
- **Partial dual-write** (critic round 1): snapshot saved, then capture extraction throws → snapshot survives (it wrote first), extracted memories missing → SessionEnd capture re-extracts the same transcript later. Accepted, self-healing. The reverse order would risk losing the headline artifact; that is why snapshot writes first.
- Snapshot written but the session dies before SessionStart(compact) → snapshot stays active; `hippo context --continuity` shows it next session. Accepted (beneficial).
- Double capture (PreCompact + SessionEnd over overlapping tail) → existing capture dedup absorbs. Accepted.

## Non-goals (v1)

- Never block compaction: no exit-2 path exists in the verb.
- No schema migration; no public CLI renames; no changes to `session-end`/`last-sleep`/pinned-inject paths.
- OpenCode plugin untouched (no compaction event in its plugin API).
- No PreCompact matcher filtering (capture on both manual and auto).
- Snapshot content QUALITY (task/next-step derivation is heuristic v1); the E2E asserts structure and caps, not prose quality. Accepted limitation, noted for LC-track follow-up (pre-compact snapshots linked to post-compact outcomes are LC training data).

## Success criteria (ROADMAP CS1)

- `hippo setup` installs the PreCompact hook for claude-code → T3.
- Mid-session compaction writes a working-state snapshot → T1.
- The following SessionStart(compact) injects it → T2.
- E2E drives a synthetic transcript through simulated PreCompact + SessionStart(compact) hook input, asserting snapshot + re-injection → T4.
- SessionEnd capture unchanged → non-goal list; no edits to that path.

## Effort / files

~1 executor day. `src/cli.ts`, `src/capture.ts`, `src/hooks.ts`, `tests/hooks.test.ts`, `tests/pre-compact-e2e.test.ts`, README/help text.
