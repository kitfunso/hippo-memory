# Non-loopback serving — lock-step sequencing commitment

**Decision (2026-05-24, D3 from `docs/design-decisions/2026-05-24-blocked-items.md`):**
Ship every gate listed below BEFORE flipping `HIPPO_BIND_ALL` (or any equivalent
non-loopback binding flag). "Behind a flag first" was rejected because the
historical pattern is "flag flips before gates close."

This document is the single-source-of-truth for what blocks non-loopback
serving. Any future plan to enable cross-host hippo access MUST verify every
item below is shipped.

## Required-firsts

- [x] **D1 — Response-shape redact-on-egress.** `redactSleepResultForCaller`
  in `src/sleep-redact.ts`. Non-loopback non-self admin gets cross-tenant
  counters zeroed in `SleepResult`. Shipped v1.12.10.
- [x] **D2 — `__host__` synthetic tenant for host-wide audit rows.**
  `api.sleep` consolidate row now tags `tenant_id='__host__'` not
  `ctx.tenantId`. Shipped v1.12.10.
- [x] **L9 background pipelines tenant scoping** (8 files).
  Shipped v1.12.1 (PR #41).
- [x] **M6 — Audit log retention.** `hippo audit prune --older-than <Nd>`.
  Shipped v1.12.9 (PR #51).
- [ ] **M7 — `validateApiKey` timing on unknown key_id.** Constant-time
  scrypt comparison only fires when the row exists; unknown `key_id`
  short-circuits before any hashing. Acceptable for the stub today
  (loopback-only); becomes a real concern under non-loopback.
- [ ] **Conflict-subsystem tenant-isolation residue (a, b, c).** Per
  `TODOS.md`: `cli.ts` / `dashboard.ts` unscoped reader sites; `dedupe.ts`
  / `memory.ts` audit pass; `replaceDetectedConflicts` stale cross-tenant
  rows auto-resolve.
- [ ] **D4 — `hippo_peers` tenant-scope (default-safe).** Optional
  callers can opt into cross-tenant via `listPeers(root, undefined)`.
  Shipped v1.12.10. (Listed here because it's a default-behaviour change
  any non-loopback story inherits.)
- [ ] **Non-loopback bind design itself.** `HIPPO_BIND_ALL` env knob or
  equivalent. TLS termination assumption documented (caddy/nginx/Cloudflare
  in front; hippo does not terminate TLS). Trusted `X-Forwarded-For`
  parsing for the per-IP token bucket (today's rate-limiter degenerates
  to one global bucket under loopback).

## What this commitment looks like in practice

When the next plan proposes non-loopback serving:
1. Open this doc.
2. Confirm every `[x]` is still accurate (run tests, grep for the
   shipped surfaces named).
3. Resolve every `[ ]` first as its own episode. Do NOT bundle them with
   the bind-flag flip.
4. Only after every item is `[x]` does the bind flag become a single
   one-line additive change.

If a future plan proposes flipping the bind flag with `[ ]` items still
open, treat that as a NO and route back to closing the missing gates.

## Why not "behind a flag first"

The historical pattern in this and adjacent projects: a flag that
gates a leaky surface gets enabled in a "let's see if it works" moment
before the leak is closed. The leak ships under the flag. The flag
becomes default-on a release later. The leak ships to defaults.

Lock-step says: don't ship the leaky surface at all. The 1-2 weeks of
focused gate-closing is cheaper than the alternative incident
postmortem.

## See also

- `docs/design-decisions/2026-05-24-blocked-items.md` — the full
  options + tradeoffs analysis for D1-D5.
- `TODOS.md` — current state of M7 and the conflict-subsystem residue.
