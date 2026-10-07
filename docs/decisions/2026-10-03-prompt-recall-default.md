# Prompt recall on by default, an exception to the default freeze

Date: 2026-10-03
Status: accepted
Links: ROADMAP.md Z1, Z11; docs/evals/2026-09-26-z1-prompt-recall-result.md; PR #364

## Context
The per-prompt hook injected pinned memories plus the five newest, whatever was asked.
Z1 gated that backfill on the prompt and shipped it behind `pinnedInject.promptRecall`,
off, because it failed its overlap gate. The Sep-30 freeze (ROADMAP Part XV) holds every
default until a valid Z0 result shows task benefit.

## Constraints and evidence
- Provenance: Keith's go on 2026-10-03 ("prompt-aware recall on by default yes"), after he
  asked why a low-touch product needed users to turn it on.
- Z1 held-out: primary overlap tied at 0.0545; median tokens 847 to 533; mean 684 to 662;
  p90 1,438 to 1,600; session-lifetime overlap median 0.086 to 0.067.
- Latency failed in the replay (p95 292 / 332 ms); 1.52.1 brought it to about 210 to 230 ms.
- Z0 has not frozen hippo at a tag yet, so its hippo arms will test whatever ships.

## Decision
`promptRecall` defaults to true from 1.55.0. A payload with a prompt gets pins plus up to 5
matching memories, or pins alone; a payload without one keeps the five newest. The Z1c
failure-recall block stays off: it adds tokens and has no scored result. The eval runner
`scripts/token-eval/ab-run.mjs` is not pinned, so Z0 tests hippo as shipped.

## Alternatives considered
- Keep the freeze until Z0 scores: weeks away, and every new user meanwhile gets the
  newest-5 hook, which ignores the prompt.
- Turn on Z1c's failure block too: more tokens, nothing scored.
- Pin the flag off in ab-run.mjs: keeps TE5 comparable but makes Z0 test a config nobody runs.

## Consequences
- A lesson saved earlier in a session no longer rides along on every prompt.
- The default carries no task-benefit claim; Z0 is still the test of that.
- Z1d's draft must name its comparator before registering.

## Reconsider when
- Z0 scores the hippo arms at or below built-in memory, or users report fresh lessons missing.
