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
- **Dispatch.** A process supervisor that starts a runtime on a card, watches
  a heartbeat, and reclaims the card if the runtime dies. See Part VII,
  section "W3. Runtime adapter kit + dispatcher".

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
- **Not unattended dispatch, not in V1.** See the boundary rules below.

## The two boundary rules

1. **`ready -> running` is human-approved in V1.** A card only starts running
   on a click or a CLI confirm. This is how Track W treats non-goal #8 (no
   autonomous actuation in V1): starting a local process is not the same as
   writing back to a source system, but it is still the first time hippo
   would start an agent rather than inform one, so it keeps a human in the
   loop.
2. **Unattended dispatch is a separate switch, off by default.** Any future
   mode where cards move to `running` without a human click is a distinct,
   explicitly enabled setting. It is not part of the V1 work plane and this
   page does not authorize building it.

## Where Linear and GitHub stay authoritative

If a card traces back to a Linear or GitHub ticket, that ticket stays the
source of truth for status and ownership. Hippo owns the runtime, the
envelope, and the outcome, not the ticket. The planned E1.5 ingestion is
read-only: it brings ticket data in, and it does not write hippo's card
state back to Linear or GitHub. See Part VII, section "Boundary with
existing non-goals".

## The one open product decision

Track W stops at "board plus envelope" (W0-W2) until this is decided:

> Does hippo spawn agent processes at all, even behind a human gate?

This is a product-scope call, not an engineering one. W3 (the dispatcher)
and W4 (limit-triggered migration) both wait on it. See Part VII, section
"Sequencing".

## Non-goal table changes

This page is the reason ROADMAP Part II's non-goals table gains two rows:

- Row 11: hippo never runs an in-process agent loop.
- Row 12: a shared transcript is never the handoff.

Both are restated above and match the wording in ROADMAP.md.
