# Hippo Roadmap: Explicit Working Memory + Session Continuity

## Why this exists
Hippo is already good at long-term semantic recall, reinforcement, and decay. The current gap is the layer above that: active task continuity, session continuity, and adoption polish.

This plan adds a Karpathy-style explicit working-memory layer on top of Hippo instead of replacing Hippo with markdown.

## Target architecture
Use four layers:

1. **Working memory layer**
   - visible, file-backed, current-task state
   - answers: what am I doing right now?
2. **Session continuity layer**
   - resumable session capsules and handoff artifacts
   - answers: what was I doing before reset, crash, cron wake, or subagent exit?
3. **Long-term Hippo memory layer**
   - semantic recall, reinforcement, decay
   - answers: what have I learned over time?
4. **Recall and handoff UX layer**
   - explainability, scoped recall, inspectable handoffs
   - answers: why was this memory returned, and what should I do next?

## Repo shape assumption
Current repo shape is intentionally small. Keep the existing MCP/server surface stable and add focused modules behind it.

Use the existing `src/mcp` area as the integration point, not the dumping ground.
New functionality should live in dedicated modules first, then get exposed to MCP and CLI.

---

# Phase 1: Working memory layer

## Goal
Make the current task explicit, inspectable, and easy to resume.

## New on-disk state
For each repo or working directory, create a hidden `.hippo/work/` folder with:

### `.hippo/work/current.md`
Human-readable snapshot.

Suggested sections:
- Objective
- Current subtask
- Blockers
- Next action
- Touched files
- Verification pending

### `.hippo/work/state.json`
Machine-readable state.

```json
{
  "version": 1,
  "repoRoot": "C:/repo",
  "taskId": "wm-20260403-001",
  "title": "Add working memory layer",
  "objective": "Make active task state explicit and resumable",
  "status": "active",
  "currentSubtask": "Define state schema",
  "blockers": [],
  "nextAction": "Implement store + serializer",
  "touchedFiles": [
    "src/working-memory/schema.ts"
  ],
  "lastCommand": "npm test",
  "lastVerifiedStep": "schema roundtrip test passes",
  "updatedAt": "2026-04-03T09:00:00Z"
}
```

### `.hippo/work/checkpoints.jsonl`
Append-only milestone log.

```json
{"ts":"2026-04-03T09:00:00Z","kind":"checkpoint","step":"defined state schema","files":["src/working-memory/schema.ts"]}
{"ts":"2026-04-03T09:10:00Z","kind":"verify","step":"schema roundtrip test passes"}
```

## New source files
Create:
- `src/working-memory/schema.ts`
- `src/working-memory/store.ts`
- `src/working-memory/render.ts`
- `src/working-memory/checkpoints.ts`
- `src/working-memory/index.ts`

If the repo already has a general filesystem/path helper area, place them under that pattern instead.

## Commands to add
### CLI
- `hippo current init --repo <path> --title <text> --objective <text>`
- `hippo current show --repo <path>`
- `hippo current set --repo <path> --subtask <text> --next <text>`
- `hippo current checkpoint --repo <path> --step <text> [--files a,b,c]`
- `hippo current close --repo <path> --summary <text>`

### MCP tools
- `hippo_current_show`
- `hippo_current_set`
- `hippo_current_checkpoint`

## Integration rule
On agent session start:
1. load `current.md`
2. load `state.json`
3. then run long-term `hippo_recall`

That ordering matters. Active state first, semantic memory second.

---

# Phase 2: Session continuity layer

## Goal
Survive `/new`, compaction, crash, cron wake, and subagent exit.

## New on-disk state
Use `.hippo/sessions/`.

### `.hippo/sessions/<session-id>.json`
```json
{
  "version": 1,
  "sessionId": "sess-20260403-001",
  "repoRoot": "C:/repo",
  "taskId": "wm-20260403-001",
  "status": "paused",
  "summary": "Working memory schema implemented, MCP exposure not started",
  "nextAction": "Add hippo_current_show MCP tool",
  "evidence": [
    ".hippo/work/current.md",
    ".hippo/work/checkpoints.jsonl"
  ],
  "updatedAt": "2026-04-03T09:15:00Z"
}
```

### `.hippo/handoffs/<handoff-id>.json`
```json
{
  "version": 1,
  "handoffId": "handoff-20260403-001",
  "repoRoot": "C:/repo",
  "taskId": "wm-20260403-001",
  "from": "background-run",
  "status": "partial",
  "whatShipped": [],
  "whatFailed": [
    {
      "step": "MCP registration",
      "reason": "type mismatch"
    }
  ],
  "nextAction": "fix tool registration types and rerun unit tests",
  "artifacts": [
    ".hippo/work/current.md"
  ],
  "updatedAt": "2026-04-03T09:20:00Z"
}
```

## New source files
Create:
- `src/session/schema.ts`
- `src/session/store.ts`
- `src/session/handoff.ts`
- `src/session/index.ts`

## Commands to add
### CLI
- `hippo session save --repo <path>`
- `hippo session latest --repo <path>`
- `hippo session resume --repo <path>`
- `hippo handoff create --repo <path> --status <status> --next <text>`
- `hippo handoff read --id <handoff-id>`

### MCP tools
- `hippo_session_latest`
- `hippo_handoff_read`

## Integration rule
Every subagent/background run should end by writing a handoff artifact.
No more transcript archaeology as the primary resume mechanism.

---

# Phase 3: Lock/contention fix

## Goal
Stop SQLite lock hangs and convert learn/sleep from fragile to robust.

## Observed problem
`hippo sleep` can hit `database is locked` while the gateway still holds the DB open. Current workaround avoids false FAIL alerts, but the underlying contention is still real.

## Design changes
Create or centralize DB access through:
- `src/db/connection.ts`
- `src/db/pragmas.ts`
- `src/db/write-queue.ts`

## Required DB behaviour
### Pragmas
Apply on connection open:
- `journal_mode=WAL`
- `busy_timeout=5000` or configurable
- `synchronous=NORMAL`

### Writer model
- one write queue for learn/consolidate operations
- short-lived read connections for recall
- avoid long-held DB handles in prompt hooks

### Consolidation behaviour
If DB is locked:
- treat as `DEFERRED`, not hard failure
- emit a structured status
- retry later from queue

### Metrics to add
Store and expose:
- lock wait ms
- deferred consolidate count
- queue depth
- connection open duration

## New source files
Create or refactor into:
- `src/db/connection.ts`
- `src/db/write-queue.ts`
- `src/learn/consolidate.ts`
- `src/learn/status.ts`

## Commands to add
- `hippo admin db-status`
- `hippo admin deferred-learns`
- `hippo admin retry-deferred`

---

# Phase 4: Better recall and handoff UX

## Goal
Make Hippo inspectable and easy to trust.

## Commands to add
- `hippo recall <query> --why`
- `hippo recall <query> --repo <path>`
- `hippo current next --repo <path>`
- `hippo handoff latest --repo <path>`

## Output expectations
### `hippo recall --why`
Return:
- memory text
- why it matched
- score/confidence
- source bucket: active, recent, durable, decaying
- stale flag if applicable

### `hippo handoff latest`
Return:
- latest handoff summary
- next step
- linked artifacts

## New source files
Create:
- `src/recall/explain.ts`
- `src/recall/format.ts`
- `src/handoff/format.ts`

---

# First PR slice

## PR1 name
**Explicit working memory + handoff skeleton**

## Why this first
It gives the biggest practical improvement with the lowest risk.
It does not require changing the DB layer yet.
It immediately improves active-task continuity and session continuity.

## Scope
### Add new modules
- `src/working-memory/schema.ts`
- `src/working-memory/store.ts`
- `src/working-memory/render.ts`
- `src/working-memory/checkpoints.ts`
- `src/session/schema.ts`
- `src/session/store.ts`
- `src/session/handoff.ts`

### Expose commands
- `hippo current init/show/set/checkpoint/close`
- `hippo handoff create/read`

### Minimal MCP exposure
Only two tools in PR1:
- `hippo_current_show`
- `hippo_handoff_read`

### Docs
- update `README.md`
- add examples for `.hippo/work/current.md`
- document the handoff JSON schema

## Not in PR1
- WAL / busy_timeout / write queue
- explainable recall
- session auto-resume
- migration of old memories
- UI/browser views

## PR1 acceptance checklist
- [ ] `hippo current init` creates `.hippo/work/current.md`, `state.json`, and `checkpoints.jsonl`
- [ ] `hippo current show` reads and prints current state reliably
- [ ] `hippo current checkpoint` appends JSONL and refreshes `current.md`
- [ ] `hippo handoff create` writes a valid handoff JSON artifact
- [ ] MCP can read current state and latest handoff
- [ ] repo-local working state survives process restarts
- [ ] README documents the workflow with one end-to-end example

## Suggested tests
- roundtrip schema test for `state.json`
- append test for `checkpoints.jsonl`
- handoff schema validation test
- `current.md` render snapshot test
- one integration test that simulates:
  1. init
  2. set
  3. checkpoint
  4. handoff create
  5. read back via CLI

---

# Concrete command examples after PR1
```bash
hippo current init --repo C:/Users/skf_s/hippo --title "working memory layer" --objective "make active task state explicit"
hippo current set --repo C:/Users/skf_s/hippo --subtask "define schemas" --next "implement filesystem store"
hippo current checkpoint --repo C:/Users/skf_s/hippo --step "schema roundtrip test passes" --files src/working-memory/schema.ts
hippo handoff create --repo C:/Users/skf_s/hippo --status partial --next "register MCP tool"
hippo current show --repo C:/Users/skf_s/hippo
hippo handoff read --id handoff-20260403-001
```

---

# Sequencing after PR1
## PR2
Session save/latest/resume on top of the same `.hippo/` file layout.

## PR3
SQLite lock/contention fix: WAL, busy timeout, writer queue, deferred consolidations.

## PR4
Explainable recall and better handoff UX.

---

# Blunt recommendation
Do **not** start with the DB lock fix as the main roadmap item.
Start with explicit working memory and handoff artifacts first.
That gives immediate user-visible value and makes the rest easier to debug.

Karpathy-style memory should be Hippo's **front-end working state**.
Hippo should stay the **semantic long-term retrieval engine** underneath.
