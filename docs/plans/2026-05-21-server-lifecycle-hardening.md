# Server / Lifecycle Hardening

Date: 2026-05-21
Status: APPROVED — eng-reviewed 2026-05-21, ready to implement (Phase 1 + Phase 2)

## Context

After the F-track LongMemEval research arc (F6-F16, mostly Gate-B FAIL), the
decision on 2026-05-21 is to pivot from research to product hardening. This
plan scopes the "server / lifecycle hardening" cluster from `TODOS.md` —
deferred follow-ups from the v0.37 server-mode work, the v0.40 security pass,
and the A3 envelope review.

All current-state `file:line` references were verified against the working
tree at commit `2eda721` on 2026-05-21.

## Eng review (2026-05-21)

Reviewed via `/plan-eng-review`. Step 0 scope check passed — Phase 1+2 touch
~3-4 files, well under the complexity smell, and the plan reuses existing code
(H1 reuses the wired `started_at`; A3 reuses `archiveRaw`). Decisions:

- **D1** — `hippo forget --archive` takes no `--owner` flag (see Phase 2).
- **D2** — Phase 3 (tenant-guard) is deferred to its own plan (see Phase 3).

Minor revisions folded in below: H1 caller scope made concrete, H1 probe
timeout specified, three test cases + a regression test added.

## Scope — this release is Phase 1 + Phase 2

### Phase 1 — server-mode robustness

All touch `hippo serve` / the HTTP server / the pidfile. These are live bugs.

**H1 — stale pidfile / PID-reuse.** `detectServer` (`src/server-detect.ts:21-44`)
proves liveness with `process.kill(pid, 0)` only. A pid reused by an unrelated
process passes, so the CLI thin-client can route to a non-hippo process.

Corrected 2026-05-21 (post-eng-review, during execution): the pidfile and
`/health` *each* record a `started_at`, but they were independent `new Date()`
calls — `server-detect.ts:57` inside `writePidfile` vs `server.ts:1416` for
`/health` — so they never matched. The fix therefore also threads `serve()`'s
single `startedAt` into `writePidfile` (a new `opts.startedAt`); the pidfile
and `/health` then carry one identical value, and `detectServer` compares for
exact equality. Still wiring, ~2 lines beyond the original plan.

Fix: make `detectServer` async; after the pid check, GET `${info.url}/health`
with a short timeout (~300ms) and compare `body.started_at` to
`info.started_at`. A mismatch, non-200, or malformed body → stale (unlink,
return null). Corrected during execution (codex review, 2026-05-21): a probe
*timeout* returns null WITHOUT unlinking, since a live but busy server can miss
the window and destroying its pidfile would orphan it. The recorded url is also
validated as loopback `http` on the recorded port before the probe (so a forged
pidfile cannot point a HIPPO_API_KEY-bearing request off-box), and the /health
body is read under a 64 KB cap.
The probe runs only when a pidfile exists and the pid is live, so the common
no-server path stays a fast file-read and the CLI hot path is not slowed.
`detectServer` has exactly one caller — `runViaServerIfAvailable`
(`cli.ts:240`), already in an async path; H3 adds a second. Size: M.

**H3 — concurrent `hippo serve`, no winner detection.** `serve()`
(`src/server.ts:~1404-1461`) calls `server.listen` directly; two invocations on
one hippoRoot race, the loser exits EADDRINUSE, the winner overwrites the
pidfile. Fix: at the top of `serve()`, call the now-async `detectServer`; if a
live peer answers `/health`, throw a clear "already running on port N" error
before `listen()`. Depends on H1. Size: S-M.

**L3 — pidfile schema version.** `ServerInfo` (`server-detect.ts:4-9`) has no
version field. Fix: add `schema: 1` to the interface and the `writePidfile`
`info` object; `detectServer` treats a missing `schema` as legacy and tolerates
it. Bundle with H1/H3 (same file). Size: S.

**H2 — `HIPPO_API_KEY` silently dropped on fallback.** `runViaServerIfAvailable`
(`cli.ts:~236-254`): on connection-refused it unlinks the pidfile and returns
false, so the caller runs direct mode and the configured `apiKey` is silently
discarded — masking a production misconfiguration. Fix: add a
`HIPPO_REQUIRE_SERVER` env knob; when set, the connection-refused branch
re-throws a clear error instead of falling back. Default behaviour unchanged.
Size: S.

**M3 — `BodyTooLargeError` leaves the socket open.** `readBody`
(`src/server.ts:~138-150`) throws on the 1 MB cap; the handler catch (`~1424`)
sends 413 but never `req.destroy()`, so the rest of the body drains into a
closed exchange. Fix: `req.destroy()` in the `BodyTooLargeError` branch after
`sendError`, on the generic route and the Slack / GitHub webhook routes (all
share `readBody`). Size: S.

### Phase 2 — lifecycle: `hippo forget` for raw rows

**A3 — `hippo forget <raw-id>` is a dead end.** `cmdForget` (`cli.ts:2678-2694`)
→ `api.forget` → `deleteEntry` → the BEFORE-DELETE SQLite trigger
`RAISE(ABORT, 'raw is append-only')`. `cmdForget`'s bare `catch` reports a
misleading "Memory not found". `--kind raw` is CLI-gated, but connector
ingestion (Slack / GitHub) creates raw rows that are legitimate forget targets.
Fix: add `--archive` and `--reason` flags to `cmdForget`; with `--archive`,
route to `api.archiveRaw(ctx, id, reason)` — which exists (`api.ts:1288`), is
tenant-checked, and is the sanctioned raw-removal path. Without `--archive`, the
catch must distinguish the append-only abort from a true not-found and tell the
user to use `--archive`. Size: M.

Decided (eng-review, 2026-05-21): **no `--owner` flag.** `archiveRawMemory`
records the archiver (`ctx.actor`) as `who` — correct provenance for an archive.
A user-supplied owner is a different concept (the envelope owner set by
`hippo remember --owner`, a separate A3 TODO); conflating it here is scope
creep. Final scope: `hippo forget <id> --archive --reason "..."`.

### Phase 3 — tenant-guard threading — DEFERRED (separate plan)

Not in this release. Recorded here for traceability.

`listMemoryConflicts` (`store.ts:2008`) and `resolveConflict` (`store.ts:2116`)
take no `tenantId`, so the `hippo_status` / `hippo_conflicts` / `hippo_resolve`
MCP tools leak and can mutate conflict rows across tenants. The fix would thread
a `tenantId` parameter through both functions, their SQL, and the MCP handlers
(`server.ts:741,776,788`). Size: L (~12 call sites).

Decided (eng-review, 2026-05-21): out of scope for this release. The leak is
latent — per `TODOS.md` L9, hippo's deployment model today is "single tenant per
deployment", so it is not currently reachable. Threading `tenantId` through SQL
is a security-shaped change that wants its own focused review and test pass.
Tenant-guard gets its own plan, sequenced with the A5 v2 multi-tenant track.

## Test plan

- **H1:** (a) live server, matching `started_at` → `detectServer` returns the
  info; (b) stale `started_at` (pid alive, `/health` returns a different value)
  → null + unlink; (c) `/health` unreachable / times out → null + unlink;
  (d) dead pid → null (existing behaviour, keep covered).
- **H3:** two `serve()` on one hippoRoot → the second throws a clear error, the
  pidfile is not corrupted.
- **L3:** a new pidfile carries `schema: 1`; a legacy pidfile (no `schema`) is
  still accepted by `detectServer`.
- **H2:** `HIPPO_REQUIRE_SERVER=1` with no server → CLI errors clearly; unset →
  falls back as today.
- **M3:** POST a >1 MB body → 413 + socket destroyed (no further bytes accepted)
  — on the generic `/v1` route AND a webhook route (Slack or GitHub), since they
  share `readBody`.
- **A3:** `hippo forget <raw-id>` → clear "use --archive" error;
  `... --archive --reason "..."` → row archived, `archive_raw` audit emitted.
- **Regression:** `detectServer` becomes async — the existing `server-detect`
  tests gain `await`, and the `writePidfile + removePidfile roundtrip` test is
  rewritten: under H1 a pidfile with no live server behind it is correctly
  stale, so case (a) "returns the info" now drives a real in-process `serve()`.
- All tests stay store-isolated — the leak guard from `2470fff` stays green.

## Risks / open questions

- H1: `detectServer` going async has a one-caller blast radius
  (`runViaServerIfAvailable`, `cli.ts:240`, already async); H3 adds a second.
  No sync caller — verified.
- M3: `req.destroy()` on the webhook routes must run after `sendError`, not race it.
- Versioning: `package.json` is `1.9.3`, `ROADMAP.md` is stale at `v0.33.0`.
  Pick the release version at ship time.

## NOT in scope

- Phase 3 tenant-guard threading — deferred to its own plan (D2).
- p99 latency hardening (`TODOS.md`: explicitly no current target).
- 24h soak harness as a CI gate (separate infra work).
- B3 dlPFC / vlPFC research items (this pivot is away from research).
- UI redesign port and Slack-connector-v2 follow-ups (other backlog clusters).
- `ROADMAP.md` refresh (overdue, but not part of this release).
