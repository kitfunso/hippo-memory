# Work plane boundary (W0)

This page sets the boundary for Track W (work plane) in ROADMAP Part VII,
section "Track W - Work plane". It is the W0 deliverable: a doc, not code.

## What the work plane is

The work plane is a queue of cards, stored in hippo's own SQLite file, that
an agent runtime claims and works. It sits next to the memory plane hippo
already has. Three things make it up:

- **Cards.** A row with a status, an assigned runtime, and a lease. See
  Part VII, section "W2. Cards table, status machine, board view".
- **Handoff envelopes.** A structured record of what happened on a card:
  summary, next action, constraints, evidence, outcome. See Part VII,
  section "W1. Handoff envelope promotion".
- **Pull-mode adapters.** A per-runtime recipe: how the runtime claims a card, a
  launch command that hippo prints and never runs, and a limit-signal hook. See
  Part VII, section "W3. Pull-mode runtime adapter kit".

## What the work plane is not

- **Not a tracker.** It does not replace Jira, Linear, or GitHub. Those stay
  the system of record for tickets. This is the non-goal #3 resolution in
  Part VII, section "Boundary with existing non-goals". Team-tracker items
  flow in through the planned E1.5 read-only ingestion. A human-approved
  write-back path can flow status back out later; there is no write-back
  today.
- **Not an in-process agent loop.** Hippo does not run a supervisor LLM that
  chats with worker LLMs, and it does not run sub-agents inside its own
  process. Runtimes (Claude Code, Codex, Grok Build, Muse Code, and so on)
  stay separate OS processes. See Part VII, section "What not to build".
- **Not a shared transcript as handoff.** The handoff is the structured
  envelope above, never a dumped context window or a shared chat log. See
  Part VII, section "What not to build".
- **Not a dispatcher.** Hippo never starts, stops or supervises a runtime. See the
  boundary rules below.

## The two boundary rules

1. **Hippo starts no agent process.** A human, or the human's own scheduler, starts
   the runtime. The runtime moves its own card from `ready` to `running` with
   `hippo card claim`. This settles non-goal #8 for the work plane: hippo informs
   an agent and never starts one.
2. **No dispatch switch exists, attended or unattended.** Building one needs a new
   decision record that supersedes
   `docs/decisions/2026-09-20-no-agent-spawn.md`.

## Where Linear and GitHub stay authoritative

If a card traces back to a Linear or GitHub ticket, that ticket stays the
source of truth for status and ownership. Hippo owns the runtime, the
envelope, and the outcome, not the ticket. The planned E1.5 ingestion is
read-only: it brings ticket data in, and it does not write hippo's card
state back to Linear or GitHub. See Part VII, section "Boundary with
existing non-goals".

## The product decision (closed 2026-09-20)

The question was:

> Does hippo spawn agent processes at all, even behind a human gate?

Answer: no. W3 and W4 go ahead in pull mode. Reasons, alternatives and the
condition that reopens it: `docs/decisions/2026-09-20-no-agent-spawn.md`. See
Part VII, section "Sequencing".

## Non-goal table changes

This page is the reason ROADMAP Part II's non-goals table gains these rows:

- Row 11: hippo never runs an in-process agent loop.
- Row 12: a shared transcript is never the handoff.
- Row 13 (added 2026-09-20): hippo never starts or supervises an agent process.

All three are restated above and match the wording in ROADMAP.md.
