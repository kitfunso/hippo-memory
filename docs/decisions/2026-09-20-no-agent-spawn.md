# Hippo does not spawn agent processes

Date: 2026-09-20
Status: accepted
Links: ROADMAP.md Part VII (Track W); docs/plans/2026-09-12-work-plane-boundary.md

## Context
Track W stopped at "board plus envelope" (W0 to W2c, shipped 1.39.0 to 1.43.0) on one
open product question: does hippo spawn agent processes at all, even behind a human
gate? W3 (dispatcher) and W4 (limit-triggered migration) waited on it.

## Constraints and evidence
- Provenance: the question was put to Keith on 2026-09-20. His reply: "Do what's best
  for us, continue until completion". Claude made the call under that delegation.
  Merging this PR is Keith's confirmation; closing it reverses the call.
- W2 has no usage data. Its success test (ROADMAP W2: a 20-card, 2-runtime dogfood
  week) has not been run, so nobody has measured the manual start step as a cost.
- The roadmap's own forecast rates cross-runtime orchestration "Medium: adapters and
  capability memory are the grind", and sizes the dispatcher at 4-6 weeks plus 2-3.
- The pull half already ships: `hippo card claim <id> --runtime <name>` (4-hour
  lease), `hippo card heartbeat`, `hippo card reclaim`, `hippo card block`
  (README command table, 1.41.0).
- A dispatcher feeds stored `hippo context` text into a process hippo itself starts.
  That is a path from stored memory to actuation, inside a published npm package.

## Decision
No. Hippo does not start, stop or supervise agent runtimes, not even behind a human
gate. The work plane runs in pull mode: a human, or the human's own scheduler, starts
the runtime; the runtime claims a card, heartbeats, and hands off with the envelope.
W3 becomes a pull-mode adapter kit. W4 becomes pull-mode limit migration.

## Alternatives considered
- Human-gated dispatcher (the W3 sketch): weeks of work on a guess, plus a published
  process-supervision surface that must then keep compat.
- Unattended dispatch: already ruled out for V1 by the boundary doc.
- Leave the question open: keeps Track W frozen for no gain.

## Consequences
- Hippo stays a memory and state layer that every runtime can plug into. It does not
  compete with the runtimes or with their permission models.
- Credentials stay in the human's own runtime session. Hippo never binds them.
- Starting the next runtime stays a manual step. That is the known cost.
- A "no" is cheap to flip later. A "yes" is not.

## Reconsider when
- The W2 dogfood week shows the manual start step is the measured bottleneck: ready
  cards sit waiting while a runtime is free.
