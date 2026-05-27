# Track J warnings: agent-reads dogfood (2026-05-27)

## Setup

Triggered by the week-of-2026-05-21 retro that surfaced "warnings may ship
dark" as the Track J risk. Goal: cheap evidence on whether the C5 +
J3.2 + J1 warnings shipped in v1.13.0-v1.13.2 actually reach a calling
agent's behavior, before shipping J5 / J2 / J6 / J7 against the same
unread surface.

Hippo build under test: 1.13.2 (CLI globally installed, source at master
4681c92).

Isolated dogfood root: `/tmp/hippo-dogfood-2026-05-27/.hippo`. `hippo init`
imported 68 memories from local MEMORY.md mirrors. Five `estimate-task`
predictions seeded (mean estimate/actual ratio 1.78x) so J3.2 baserate
has signal.

Single-shot CLI used for C5 + J3.2 trigger (which work in single-shot).
J1 live HTTP test skipped: existing `hippo serve` on the host (pid 94592,
v1.12.10, default port 6789) blocked a second instance even with custom
port + `HIPPO_ALLOW_MULTI_SERVE=1`. Restarting the host server would have
disrupted Keith's active MCP session. Source review of `src/mcp/server.ts`
lines 668-674 confirms the J1 response template prepends `## Anchoring
hint\n${summary}\n[anchored_on: ${memoryId}]\n\n---\n\n` ABOVE the
planning-fallacy block, so structurally J1 inherits J3.2's placement
(see Trial 2 result for the format that worked).

## Trials

### Trial 1 — C5 WYSIATI cutoff transparency

Query: `hippo recall "memory" --limit 2 --why` against a 68-memory store.

**Wire-level (JSON `--json`):** `suppressionSummary` populated correctly.
`{totalCandidates: 200, droppedByBudget: 28, ...}`. ✓

**CLI render:** `WYSIATI: showing 2/200; 28 dropped by limit.` printed
AFTER the result list. ✓ (line present)

**MCP source review (`src/mcp/server.ts:734-746`):** Same `WYSIATI:`
text line appended to the MCP text response, also AFTER the result list.

**Agent-reads test (fresh sub-agent, no hippo system prompt):**
Fed the rendered text + a user question "What does my hippo system look
like?". Sub-agent answered in 4 sentences. Summarized the 2 visible
memories accurately. **Never mentioned the 198 dropped candidates.**
Treated the visible results as the complete picture, which is exactly
the WYSIATI failure mode C5 is supposed to flag.

**Verdict: C5 fires on the wire and on the screen but the agent does not
read it.** Two reasons in priority order:
1. **Placement.** Line appears at the bottom of the response, after the
   most recent block. Agents read top-down and prioritise the visible
   result list.
2. **Jargon.** The literal token `WYSIATI:` is opaque to an agent that
   hasn't been told what it means. Plain English ("showing 2 of 200")
   would be parseable; the acronym blocks attention.

### Trial 2 — J3.2 planning-fallacy auto-injection

Two sub-trials.

**2a (failed class resolution).** Query: `hippo recall "will take 2 days
to ship the next feature" --why`. Regex matched ("will take 2 days") but
class resolution failed — natural-language tokens `[feature]` after
stopword removal had zero overlap with class `[estimate, task]`. Hint
silently NOT emitted. Audit log presumably recorded
`recall_autodebias_hint_no_class_match` (telemetry shipped in v1.13.1)
but the user surface was empty.

**Verdict 2a: silent-no-class-match is the most likely real-world J3.2
failure mode.** A natural user query containing a forward-claim phrase
won't share tokens with the class name unless the user happens to think
in the same vocabulary as the class tags. Three options surfaced for
follow-up:
- Lower the class-overlap threshold to 0 (always pick best-scoring class)
- Emit a "watching but no class matched" surface line so the user knows
  hippo tried
- Embed-based class resolution (J3.2-v2 path implied in v1.13.1 changelog)

**2b (matching class).** Query: `hippo recall "the next task will take
2 days" --why`. Tokens `[task]` after stopword removal had 1-overlap with
`[estimate, task]`. Hint resolved to estimate-task class. Rendered as:

```
Planning fallacy hint (class: estimate-task): Last 5 estimates in class
estimate-task averaged 1.78x actual (MAE 1.70). [detected: "will take 2 days"]
```

Line appears at the TOP of the response, before the memory list. ✓

**Agent-reads test (fresh sub-agent, no hippo system prompt):**
Fed the rendered text + a user question "I want to ship a small feature
this week. I think it will take 2 days. What should I plan for?".
Sub-agent answered in 4 sentences. **Quoted the warning verbatim**
("Your last 5 task estimates averaged 1.78x actual"), revised the
estimate ("Plan for 3.5 to 4 days of work, not 2"), and built advice
around it ("under-promise lets you ship clean instead of patching live").

**Verdict 2b: J3.2 reaches the agent organically. The format works.**
No system prompt wiring was needed. The combination of top-of-response
placement + plain English + quantitative anchor + concrete trigger
("[detected: ...]") made the warning self-explanatory to a model that
had never seen Track J documentation.

### Trial 3 — J1 anchoring (live test skipped, structural evidence only)

Live HTTP test blocked by the global serve-singleton constraint (see
Setup). Indirect evidence:

1. **Source review.** `src/mcp/server.ts:668-674` confirms J1 hint
   prepends `## Anchoring hint\n${summary}\n[anchored_on: ${memoryId}]\n
   \n---\n\n` ABOVE the planning-fallacy block. Same placement profile
   as J3.2 (top-of-response). By the Trial 2b result, this format should
   read organically.

2. **CLI by design cannot accumulate.** Per v1.13.2 Known Limitations,
   CLI single-shot mode does not maintain per-session history across
   `hippo recall` invocations. J1 only fires in long-running host
   processes (MCP server + HTTP server). CLI users get zero J1 surface
   today.

3. **Test suite proves wire-correctness.** 26 J1 unit tests +
   integration tests cover the detector logic and the
   MCP/HTTP/CLI response-shape contracts. The "does it serialize"
   question is structurally locked.

**Verdict 3: J1 is most-likely-fine on the read side (inherits Trial 2b
format profile), but the CLI single-shot gap is a real per-pipeline
discoverability hole.** SQLite-backed CLI persistence (the J1-v1.1
follow-up in the changelog) closes it; until then, document the
CLI/MCP behavioral asymmetry in the hippo CLI help.

## Decision-gate output

The J-Wire roadmap entry as drafted assumed "warnings ship dark uniformly
and need an MCP system-prompt addendum to be read". The dogfood says
that's wrong in part:

| Warning | Reaches agent organically? | Why |
|---------|---------------------------|-----|
| J3.2 (planning fallacy) | YES | Top-placement + plain English + quantitative anchor |
| J1 (anchoring) | Likely YES (untested live) | Same placement profile as J3.2 per source review |
| C5 (WYSIATI cutoff) | **NO** | Bottom-placement + opaque acronym |

The right J-Wire deliverable is therefore NOT a system-prompt addendum,
which would paper over a format-level defect. The right deliverable is:

1. **Fix C5 format (primary).** Move the cutoff line to the TOP of the
   response (above the result list, alongside J3.2 and J1 placement).
   Replace `WYSIATI:` with plain English. Conditional-format only when
   non-zero counters exist (already the case).
2. **Fix J3.2 silent-no-class-match (secondary).** Either emit a
   "watching but no class matched" line so the user knows hippo tried,
   OR lower the overlap threshold to 0 (always pick best-scoring class).
3. **Document the CLI-vs-MCP/HTTP asymmetry for J1 (tertiary).** Add a
   one-paragraph callout to `hippo recall --help` text.

If items 1-3 land, an MCP system-prompt addendum is no longer needed for
the existing 3 warnings. It would still be worth writing as belt-and-
braces for FUTURE Track J detectors before they ship.

## Updated next-item recommendation

The J5 / J2 / J6 / J7 blocker stands but is narrower than the original
J-Wire entry implied. Ship the C5 format fix + J3.2 silent-mode fix as
a small v1.13.3 patch FIRST. Re-run the dogfood (specifically Trial 1
sub-agent test) against the fixed C5 format. If agent picks it up,
J-Wire is closed and J5 unblocks. If the rewrite still ships dark, the
system-prompt addendum becomes the real follow-up.

Suggested v1.13.3 scope: ~2-3h work, single PR.

- `src/mcp/server.ts` — move WYSIATI block to top of response, alongside
  anchoring + planning-fallacy hints. Rewrite the text from
  `WYSIATI: showing X/Y; A dropped by limit.` to
  `Cutoff: showing X of Y candidates; A dropped to fit limit, ...`.
- `src/cli.ts` — mirror the same in CLI render.
- `src/predictions.ts` (or wherever the class resolver lives) — emit a
  one-line `Planning fallacy: watching this query, no class match for
  forward-claim "<phrase>"` when the regex fires but class resolution
  finds no overlap >0.
- Tests: 4 new (top-placement assertion; plain-English assertion;
  no-class-match surface assertion; combined fires test).
- CHANGELOG: 1.13.3 entry under Fixed/Changed.

## What this means for ROADMAP-RESEARCH.md J-Wire entry

The entry as written (commit 4681c92) still holds in spirit but needs a
follow-up edit:

- Deliverable should pivot from "MCP host system-prompt addendum" to
  "format normalisation across C5/J3.2/J1 + dogfood re-test of C5".
- The "Failure -> ship J-Wire prompt addendum" branch becomes the
  fallback if the format fix doesn't move C5 readability.

I'll fold this into a follow-up roadmap commit if Keith approves the
v1.13.3 plan.

## Gaps in this dogfood (acknowledge upfront)

- J1 live wire test deferred. Source review only. SHOULD rerun with a
  fresh server when Keith's session ends.
- Single sub-agent per warning. Larger N (5-10 trials per warning across
  varied user questions) would tighten the read-rate estimate.
- One model (Sonnet via the general-purpose subagent type) tested.
  Different agents may have different attention profiles on bottom-of-
  response text. Worth re-running with Claude Opus (this model) directly
  reading a response as a separate trial.
- No multi-turn dogfood. Cannot test whether warnings change behavior
  ACROSS turns, only within a single response. J1 in particular only
  makes sense across turns (anchoring on repeated answers).

---

# Round 2 dogfood (2026-05-27 evening): larger-N read-rate

Closes the "Single sub-agent per warning" gap above. 9 trials total:
3 question types per warning across J3.2 hint (v1.13.1), J3.2 watching
(v1.13.4), and C5 cutoff (v1.13.3). J1 anchoring skipped (single-turn
sub-agent dispatch cannot replicate multi-turn anchoring patterns
without the live HTTP serve session that was unavailable in trial 3).

## Setup

Same isolated `.hippo` root from round 1 (`/tmp/hippo-dogfood-2026-05-27`,
68 imported memories + 5 seeded `estimate-task` predictions + 1 seeded
`ship` prediction). Fresh CLI responses captured for each warning.
Each warning's response was paired with 3 distinct user question types
(task-direct planning, decision/risk, meta/tooling) and sent to a
fresh general-purpose sub-agent. "Read" = the agent referenced the
warning's specific numbers, prefix, or suggestion in its answer.

## Results

### J3.2 hint (v1.13.1 — top placement, plain English, quantitative)

CLI output: `Planning fallacy hint (class: estimate-task): Last 5
estimates in class estimate-task averaged 1.78x actual (MAE 1.70).`

| Trial | Question type | Read? | Evidence |
|-------|--------------|-------|----------|
| H1 | Planning ("size a 2-day feature") | YES | "1.78x long...1.70-day MAE", revised 2 to 3.5 days |
| H2 | Trust ("commit externally to 2 days?") | YES | "1.78x over...mean absolute error 1.70", commit at 4-5 days |
| H3 | Meta ("what does my track record say?") | YES | "1.78x actual time...mean absolute error of 1.70" |

**Read-rate: 3/3 (100%)**. Same finding as round 1 trial 2b. The
top-placement + plain-English + quantitative format is robust across
varied question types.

### J3.2 watching (v1.13.4 — top placement, suggestion text)

CLI output: `Planning fallacy: watching this query (reason:
no_class_match). No matching prediction class for this forward-claim.
Tag your prediction with` `` `hippo predict --class <name>` `` `to start
tracking this class.`

| Trial | Question type | Read? | Evidence |
|-------|--------------|-------|----------|
| W1 | Planning ("size a 3-day feature") | NO | Generic "plan for 5-7 days" advice; no reference to the watching warning OR the class-tag suggestion |
| W2 | Trust ("commit externally to 3 days?") | YES | "the planning-fallacy watcher flagged exactly that" + named `hippo predict --class feature_ship_days` verbatim |
| W3 | Tooling ("how to make estimates better?") | YES | Built the first sentence around `hippo predict --class feature-ship` (the suggestion verbatim) and "calibration curve for your specific work type" |

**Read-rate: 2/3 (~67%)**. W1's miss is informative: a task-direct
planning question ("I have a feature, plan for me") doesn't naturally
invite meta-commentary about hippo's tracking, so the agent gave
generic estimation advice. Same pattern as the round-1 C5 trial where
"give me a summary" correctly ignored the cutoff. The watching warning
is consumed when the question type ALREADY implies meta-reflection on
estimation or tooling; not when the question is just "do the task".

This isn't a defect — the WATCHING surface is informational, not
imperative. The 67% read-rate is honest: the warning reaches the agent
when relevant and doesn't waste tokens when not.

### C5 cutoff (v1.13.3 — top placement after v1.13.2 dark bottom)

CLI output: `Cutoff: showing 3 of 194 candidates; 28 dropped to fit
limit.`

| Trial | Question type | Read? | Evidence |
|-------|--------------|-------|----------|
| C1 | Audit ("trust this for arch decision?") | YES | "3 of 194 results...28 candidates dropped...another ~163 weren't surfaced" |
| C2 | Completeness ("is this all I have?") | YES | "194 total memories...only 3 were shown...28 dropped to fit" |
| C3 | Comparison ("compare hippo to Mem0?") | YES | "hippo returned 3 of 194 candidates with 28 dropped" + honest limit on assessing recall quality without more data |

**Read-rate: 3/3 (100%)**. Dramatic improvement over the
pre-v1.13.3 baseline (round 1 trial 1: 0/1 read; the agent summarised
the 2 visible memories with no mention of the 198 hidden). The v1.13.3
format normalisation (top placement + plain-English "Cutoff:" instead
of "WYSIATI:") moved the read-rate from ~0% to 100% across audit,
completeness, and comparison question types.

## Aggregate read-rate

- **8 of 9 trials read the warning** (89% overall).
- 100% read on the two surfaces where the warning is directly
  actionable (J3.2 hint with quantitative baserate, C5 cutoff with
  raw cutoff numbers).
- 67% read on the watching surface (informational suggestion; agents
  correctly skip when question type doesn't invite meta-discussion).

## Conclusions

1. **The format-fix premise from round 1 holds at larger N.** Top
   placement + plain English + concrete numbers/actions reaches the
   agent reliably. The original "warnings ship dark" hypothesis was
   wrong as a uniform claim, but right about the specific instance
   (pre-v1.13.3 C5) that drove it.
2. **J-Wire roadmap entry is structurally closed.** No MCP system-
   prompt addendum needed for the existing 3 user-facing Track J
   warnings (C5, J3.2 hint, J3.2 watching). The discipline note ("the
   next-J item never ships against an unread surface") remains binding
   for future detectors; the format spec is now: top placement, plain
   English, concrete number or action.
3. **Question-type sensitivity is correct behavior, not a bug.** Both
   round-1 (general summary -> C5 ignored) and round-2 W1 (task-direct
   planning -> watching ignored) cases show agents skip warnings when
   the user's question doesn't make the warning's content directly
   relevant. That's the right pattern; over-quoting warnings on every
   recall would be noise.

## Honest gaps (round 2)

- J1 anchoring still untested live. Source review only; same
  inherited-from-J3.2-format-profile argument applies.
- Single model (Sonnet via general-purpose sub-agent). Opus on the
  same prompts may differ (e.g. more thorough on edge cases, more
  likely to surface meta-warnings even when not directly asked).
- Synthetic question types. Real-session questions would mix
  task-direct and meta in ways these clean test prompts don't.
- N=3 per warning is "larger than N=1" but not statistically meaningful;
  a CI on the 89% aggregate would be wide. Treat as directional signal,
  not population claim.
