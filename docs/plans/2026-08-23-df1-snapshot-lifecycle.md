# DF1 — Active task snapshot lifecycle (never-expires fix)

Status: Draft (episode 01M0PWEHVR7KX7V3Z068CB4ZMT, plan stage)
Roadmap: ROADMAP.md Part VI, DF1 [next]
Base: origin/master e928179 (v1.33.0)

## Problem

A task snapshot written by `hippo pre-compact` stays `status='active'` forever
unless a later pre-compact supersedes it or an operator runs the manual clear.
`loadActiveTaskSnapshot` (src/store.ts:2521) has no age bound and no session
guard, so the ambient injection surfaces carry any orphaned snapshot into
every prompt of every later session in the tenant.

Live incident: a 2026-08-15 snapshot (session f235ebd3, task "/compact")
injected into every prompt for 7 days, ~800 tokens per prompt.

## Root cause

Producer-without-lifecycle: the snapshot has a birth path (pre-compact) and a
supersede path (next pre-compact) but no death path tied to the session that
owns it. The guard concept already exists in-repo — compact-resume's X5
session-mismatch suppression (src/cli.ts:3050) — but never reached the ambient
read surfaces. This is the Part VI pattern: the verifier exists downstream of
where it is needed.

## Call-site map (all 9 `loadActiveTaskSnapshot` readers, audited)

| Site | Surface | Class | Change |
|---|---|---|---|
| src/api.ts:2402 | `apiContext` (UserPromptSubmit hook) | AMBIENT | bounded read |
| src/mcp/server.ts:1116 | MCP recall context block | AMBIENT | bounded read |
| src/api.ts:1021 | `recall --continuity` | explicit | unchanged |
| src/cli.ts:1670 | CLI continuity block | explicit | unchanged |
| src/cli.ts:3055 | compact-resume (has X5 guard) | explicit | unchanged |
| src/cli.ts:3937 | `snapshot show` | explicit | unchanged |
| src/cli.ts:4012 | `session latest` | explicit | unchanged |
| src/cli.ts:5742 | session show | explicit | unchanged |
| src/capture.ts:1065 | pre-compact per-field merge | producer | unchanged |

`loadActiveTaskSnapshot` is a public export (src/index.ts:20). Its signature
does not change (additive-API rule).

## Design

Two layers; neither alone suffices.

### T1 — store: bounded read + scoped close (src/store.ts, additive)

- `loadFreshActiveTaskSnapshot(hippoRoot, tenantId, opts?: { maxAgeMs?, sessionId? })`
  Wraps `loadActiveTaskSnapshot`, then applies, in order:
  1. **Owner match** — ONLY when BOTH `opts.sessionId` AND
     `snapshot.session_id` are non-null, non-empty strings and strictly
     equal (`===`). Owner reads are unbounded.
  2. **Age check** — everything else, including absent-vs-absent ids
     (a null/undefined/empty id on EITHER side NEVER short-circuits as an
     owner match; it falls through here): return the snapshot only when
     `age(updated_at) <= maxAgeMs` (default 72h,
     `SNAPSHOT_AMBIENT_MAX_AGE_MS`, exported). Else null.
  No SQL change; age derives from the existing `updated_at` column — no
  migration. Rationale for rule 1's strictness: `runPreCompact` can
  legitimately save a snapshot with `session_id = null` (payload without the
  field, capture.ts:979); a null-equals-null owner match would reopen
  indefinite ambient injection for exactly those rows.
- `closeTaskSnapshotsForSession(hippoRoot, tenantId, sessionId, status = 'session-ended')`
  `UPDATE task_snapshots SET status=?, updated_at=? WHERE status='active' AND
  tenant_id=? AND session_id=?`. Returns the count. Scoped by session_id so a
  concurrent session's active snapshot is untouched.
- Both exported from src/index.ts (additive).

### T2 — ambient surfaces route through the bounded read

- `apiContext` (src/api.ts:2402): call `loadFreshActiveTaskSnapshot` with the
  current session id. Session id source: the `context` dispatch case gains a
  stdin-payload parse guarded at dispatch level exactly like the pre-compact
  and compact-resume cases (cli.ts:8776-8797):
  `if (!process.stdin.isTTY) { try { stdinText = fs.readFileSync(0, 'utf8'); } catch {} }`
  — the isTTY guard is mandatory because `hippo context` is both the hot
  UserPromptSubmit path and a manually-invocable command; an unguarded
  `readFileSync(0)` would block an interactive invocation waiting for EOF
  (cmdSessionEnd's guardless read is the WRONG sibling to copy — it only runs
  under a hook). Fall back to `HIPPO_SESSION_ID` env; absent both, pure
  freshness bound applies. `ContextOpts` (src/api.ts:2295) gains optional
  `currentSessionId` (additive).
- MCP recall block (src/mcp/server.ts:1116): bounded read, no session id
  (freshness bound only).
- Downstream fields (`sessionHandoff`, `recentSessionEvents` in apiContext)
  key off the returned snapshot exactly as today: bounded-out snapshot means
  no anchor, which is the existing "no snapshot" branch — no new states.

### T3 — session-end closes the owning session's snapshot (src/cli.ts)

- `cmdSessionEnd`: extract `payload.session_id` from the hook stdin JSON
  (exact pattern of the existing `transcript_path` extraction, cli.ts:3115),
  pass `--session-id` to the detached worker argv.
- `cmdSessionEndWorker`: after sleep + capture complete, call
  `closeTaskSnapshotsForSession`. Session-end's own capture pipeline never
  writes snapshots (its producers are `runPreCompact`, capture.ts:943/1113,
  and manual `hippo snapshot save`, cli.ts:3909 — neither runs inside
  session-end; verified), so the close cannot destroy same-run work. No
  session_id in payload → no-op plus one log line.

### Build/verify order (binding for execute)

T1 first — land the two store helpers and get tests 1-5 (incl. 2b) green
against the real DB before any call site changes. Then T2 — reroute the two
ambient surfaces, tests 7-8 green. Then T3 — session-end wiring, test 6
green. Each layer is independently verifiable; a T2/T3 defect can never be
confused with a T1 semantics bug.

### Existing stale rows

No migration. The bound makes them inert on ambient surfaces immediately;
they remain visible to `snapshot show` (honest) and get superseded by the
next pre-compact. Document `hippo snapshot clear` as the manual cleanup in
the changelog entry.

Out of scope, stated explicitly: the `active-task.md` mirror file
(writeActiveTaskMirror, store.ts:640) keeps being refreshed with the raw
snapshot by the wrapped inner read. No in-repo consumer reads that file
(grep-verified); mirror lifecycle is DF2/AT-territory, not this episode.

## Non-goals

- No schema migration, no new columns, no status-enum table.
- No behavior change on any explicit continuity surface (rows 3-9 above).
- No re-scoping of what pre-compact writes (DF2 territory).

## Tests (real DB, per project convention)

1. RED-under-old incident pin: session-A snapshot, `updated_at` backdated 7d,
   `apiContext` for session B → must NOT inject (old code: injects).
2. Owner unbounded: same snapshot, `apiContext` with session-A id → injects.
3. Fresh cross-session continuity preserved: backdated 1h, session B →
   injects (the designed "where you left off" case survives).
2b. Null never owns: snapshot with `session_id = null`, backdated 7d, caller
   passes `sessionId: undefined` AND separately `sessionId: null` AND
   `sessionId: ''` → all fall through to the age check and return null.
   Same with a null-session or empty-string-session snapshot and a real
   caller id, and a real-session snapshot with a null/empty caller id —
   every absent/empty/mismatch combination age-checks.
4. Boundary: exactly at `SNAPSHOT_AMBIENT_MAX_AGE_MS` → injects; 1ms past →
   does not.
5. Scoped close: one active row per tenant (supersession at save), owned by
   session A. `closeTaskSnapshotsForSession(..., 'session-B')` → returns 0,
   A's row still `active`. `closeTaskSnapshotsForSession(..., 'session-A')`
   → returns 1, row status `session-ended`, `updated_at` refreshed.
6. Session-end wiring: worker argv carries `--session-id` when payload has
   one; worker without the flag no-ops the close.
7. MCP surface: backdated snapshot absent from the MCP context block.
8. Explicit-surface regression: `snapshot show` still returns the backdated
   active row; compact-resume same-session path unchanged.

## Acceptance (ROADMAP DF1, verbatim targets)

- Red-under-old test pins the incident (1).
- Compact-resume within the same session still restores (8, plus X5 tests
  stay green).
- `session-end` leaves no `active` snapshot behind for that session (5, 6).
- Live Aug-15 row: closed by first same-session session-end or superseded by
  next pre-compact; ambient injection stops immediately via the bound;
  `hippo snapshot clear` documented.

## Risks / grill findings

- 72h default chosen over 48h so a Friday-evening orphan still offers
  continuity Monday morning; constant exported, opts-overridable, no env knob
  (Simplicity First).
- `session-end` is not guaranteed to fire (crash, kill -9): the freshness
  bound is the backstop layer. Both layers ship together.
- `cmdContext` stdin parse is fail-soft: manual invocations without a hook
  payload keep today's behavior minus stale rows (bound still applies).
- Concurrent sessions: only one `active` row exists per tenant (supersession
  on save). The scoped close means an ending session never kills a newer
  session's snapshot. X5 suppression at compact-resume is untouched.
