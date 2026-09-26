# Z1b tool-output recall replay: result (2026-09-26)

Pre-registration: [2026-09-26-z1b-tool-recall-prereg.md](2026-09-26-z1b-tool-recall-prereg.md), locked at commit `4652d74` before any Z1b configuration was scored. Aggregates only; the transcripts and stores are private.

**Verdict: FAIL at the pick rule. No Z1b hook code ships.** No grid configuration met the token eligibility rule on the tune split, and none came near the overlap bar. An exploratory judge run, outside the locked gates, found that the recalled memories help with the failure far more often than what the hook already injects. That is the lead for the next arm, not a pass.

## Tuning (tune split, 40 configurations)

- **Overlap:** the best reset-variant median was 0.0746 (several configs tie), against A1's 0.0566 and the 0.114 bar.
- **Tokens:** every configuration had a median above A1's 746 tokens per hook prompt, from 759 at the strictest to 835 at the loosest. So none was eligible, and the pick is empty.
- **Why the median gate cannot be met:** Z1b only adds tokens to A1's, never removes them. A1's per-prompt tokens take few distinct values, and its median sits just below a jump. Even the strictest config, with 14 blocks over 1,924 prompts, moved the median from 746 to 759. The prereg's own grill expected the median to hold and the mean bound to do the work. The data says otherwise, and that was a prereg design error.
- Non-routine Bash failures seen: 585 on tune, 459 on held-out. The store copies hold no `auto-captured` memories.

## Held-out, scored once at the strictest grid point (jaccard 0.12, minShared 3, maxItems 3)

| Gate | A1 | Z1b | Bar | Result |
|---|---:|---:|---|---|
| Primary overlap, reset, median | 0.0545 (35 events) | 0.0545 (37 events) | at least 0.114 and A1 + 0.05 | FAIL |
| Events where Z1b added a memory | n/a | 3 | at least 15 for the judge | FAIL |
| Median / mean tokens per hook prompt | 847 / 684 | 853 / 693 | median at most A1, mean at most 1.10 x A1 | FAIL on median |
| Latency | not measured | not measured | only if 1 to 3 pass | n/a |

A1's held-out numbers match the Z1 result exactly (0.0545 over 35 events, median 847 tokens), so the replay extension changed nothing in the existing arms.

## Exploratory, outside the locked gates

This was run after the FAIL, with jaccard 0.08, minShared 2, maxItems 3. That config tied for the best tune overlap with the lowest mean tokens. It was chosen on tune numbers only and was not tuned on held-out.

- **Overlap:**
  - Reset median 0.0545 over 58 events.
  - Session-lifetime median 0.103 against A1's 0.086.
  - The lexical scorer barely moves, even though the query and the scored text overlap by construction.
- **Tokens:** median 883 and mean 777, which is 1.14 times A1's mean.
  - A block went out in 13.6% of prompt intervals.
- **Blind judge** (Sonnet, the locked prompt, one pass, arms shuffled and unlabelled), over 33 held-out signal events where Z1b added a memory:
  - The tool-recalled memories (T) helped on 14 of 33 events, a rate of 0.42.
  - The control (C, the newest memories A1 had in context) helped on 0 of 33.
    - 23 of those 33 controls were empty, so they were scored NO without judging.
    - The judge said NO to the other 10.
  - This would have met the judge bars: T at least 0.30, T minus C at least 0.15, and at least 15 events.
  - None of the T memories on these events was created in the 10 minutes before its failure. So the lead does not come from a lesson written about the same failure moments earlier.

The judge sees help that the lexical overlap scorer does not. The locked gates fail on the scorer and on a token rule that no additive arm can meet. Neither gate is evidence that the recalled memories are useless.

## Latency fix (ships)

`scripts/z1-latency.mjs`, 10,000 memories, p95 short / long prompt:
- Before: A1 216 / 206 ms, Z1 260 / 288 ms.
- After, two runs: A1 173-179 / 179-180 ms, Z1 211-217 / 226-229 ms.

The start-up fix (a constant dummy hash in place of a scrypt call at module load) takes about 20 ms off both arms. The prompt-path changes (one connection per store, the 8 rarest prompt terms by full-text document count) roughly halve Z1's extra cost over A1: from 44 / 82 ms at p95 to about 38 / 48 ms.

About 40 ms remains. A CPU profile of the long prompt splits it three ways:
- About 24 ms is BM25 ranking in the candidate query. The bench's synthetic store uses a 30-word vocabulary, so even the rarest terms match most rows; a real store's rare terms match far fewer.
- About 15 ms is the second open per store.
- About 6 ms is the recall block's token-ledger write.

Separately, every store open, in both arms, spends about 20 ms counting rows to check the full-text index is in sync. That is not specific to Z1 and is left for its own change.

## NOT DONE

- **A Z1c pre-registration.** It would lock the judge as the primary gate and use a mean-token bound in place of the median. It would also add a second judge pass or a second judge model, because one Sonnet pass is thin for a primary gate. Then it would re-run held-out on a fresh transcript window, since this held-out split has now been seen by the exploratory run.
- **The failure hook's own cost.** `capture-error` already loads every memory for its repeat check. That is about 240 ms p50 at 10,000 memories, before any recall.
- **Whether the agent behaves differently.** TE5 is the paired test for that.

Reproduce: `node scripts/z1-replay.mjs --arm z1b --mode grid --split tune ...`, then `--mode final --split heldout --config '{"metric":"jaccard","threshold":0.12,"minShared":3,"maxItems":3}'`. The exploratory run uses `--config '{"metric":"jaccard","threshold":0.08,"minShared":2,"maxItems":3}' --judge-out <private path>`. Corpus and store flags are as in the Z1 prereg.
