# Z1 prompt recall replay: result (2026-09-26)

Pre-registration: [2026-09-26-z1-prompt-recall-prereg.md](2026-09-26-z1-prompt-recall-prereg.md), locked at commit `4ea49c3` before any tuning. Only aggregate numbers appear here; the transcripts and memory stores are private and stay off the repo.

**Verdict: FAIL on two of three gates. Z1 ships behind `pinnedInject.promptRecall`, off by default, with the tuned gate values as its defaults.** Gating the hook's backfill on the prompt did not raise the overlap between injected memory and the failures that followed, and it made the hook slower. It did cut the median injected tokens.

**Addendum (2026-10-03): default on from 1.55.0.** Keith turned `promptRecall` on by default as an exception to the Sep-30 default freeze, for the token cut and the low-touch goal. The verdict above stands; the default claims no task benefit. 1.52.1 brought hook p95 to about 210 to 230 ms, under the 280 ms bar, so the latency gate's failure no longer holds. The overlap and tail-token costs below still do. ROADMAP Z11 records the exception.

## Tuning (tune split only)

The 40-config grid ran on the tune split. The primary overlap was flat: every eligible config scored between 0.0545 and 0.0556, and A1 scored 0.0566 on the same 45 signal events with a context. The pick rule took jaccard, threshold 0.04, minShared 2, maxItems 5 (median 0.0556, median tokens 668 against A1's 746). No config came close to the 0.114 bar on tune, so the held-out run was a formality.

## Held-out (scored once, picked config)

| Gate | A1 (today's hook) | Z1 | Bar | Result |
|---|---:|---:|---|---|
| Primary overlap, compaction-reset context, median | 0.0545 | 0.0545 | Z1 at least 0.114 and at least A1 + 0.05 | FAIL |
| Signal events with a context (guard) | 35 of 92 | 35 of 92 | at least 15 | met |
| Median tokens per hook prompt (1,364 prompts) | 847 | 533 | Z1 at most A1 | PASS |
| Hook p95, 10,000 memories, short / long prompt | 215 / 196 ms | 292 / 332 ms | Z1 under 280 ms | FAIL |

Secondary numbers, for the record:
- Session-lifetime overlap median: A1 0.086, Z1 0.067 over 87 events. Z1 has more events at 0.2 or above (17 against 6), so it helps a few events and dilutes the rest.
- Z1 mean tokens 662 against A1's 684; p90 1,600 against 1,438. The recall block is never TE2-skipped, so its tail is longer.
- Z1 injected no recall block on 32% of hook prompts.

## Latency

Two runs of `scripts/z1-latency.mjs` at the tuned defaults gave Z1 p95s of 295 / 322 ms and 292 / 332 ms (short / long), with A1 at 213 / 207 ms and 215 / 196 ms. A1 is under 0.28 s on this box, so the prereg's within-10% fallback does not apply. The extra 50 to 120 ms is the two FTS candidate queries and the per-candidate tokenising. An earlier run at the pre-tuning placeholder gate (cosine 0.2, 3 items) had a noisy A1 above 0.28 s and is not used.

## Why it failed

The signal events are failing Bash commands. What the user typed before them shares little vocabulary with the error text, so memories that match the prompt match the failure no better than the five newest memories do. On the reset metric, 57 of 92 held-out events have no hook context in either arm, which caps what any hook change can move.

## Replay limits

The replay orders pins oldest-first, where the real hook orders them by strength. That only changes which pins are sent when they overflow the budget. Here they never do: at most 740 pin tokens against a 1,500-token budget, local and global combined. So the measured sets and token counts are unaffected. A corpus with more pins would need production's ordering.

## NOT DONE

- A relevance judge (Jev yes/no, or embeddings) in place of lexical overlap. The prereg named it as the next arm if this one failed on overlap.
- Matching recall against the agent's own recent tool output, not the prompt. The failures are about commands, and the prompt is the wrong query for them.
- Whether any of this changes agent behaviour. TE5 is the paired test; this replay is the cheap screen.

Reproduce: `node scripts/z1-replay.mjs --mode grid --split tune ...`, then `--mode final --split heldout --config '{"metric":"jaccard","threshold":0.04,"minShared":2,"maxItems":5}'`, with the corpus and store flags in the prereg; `node scripts/z1-latency.mjs` for latency.
