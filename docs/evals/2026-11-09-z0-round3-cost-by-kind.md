# Z0 round 3 cost by task kind: where hippo's cost goes

Date: 9 Nov 2026. Exploratory read of round 3's scored records, not a scored run. It makes no model calls and costs
nothing. Script:
`node scripts/token-eval/z0-cost-by-kind.mjs --analyzer <checkout of 04835462b>` (add `--json` for one JSON object).
The script imports the frozen round 3 analyzer (commit `04835462b` on `origin/z0/r3-cleanclaude`, pinned in
`C:/z0-runs/scored/pins-r3c.json`), because that analyzer is not on master. All figures below come from one run on
Node v24.13.0.

## Answer

Hippo's capture step costs about 4%, and most of that cost is on teach tasks. Hippo costs 3.9% more than sham
hippo over sets R and N, 1.039 [1.008, 1.070], p 0.013, which is $12.41 on $320.38 (A2/A5, all
seeds). Sham hippo is hippo with capture removed (base prereg line 83). Teach tasks carry $7.42 of the $12.41:
A2/A5 teach is 1.068 [1.011, 1.129], p 0.021.

Hippo and built-in memory cost the same overall: A2/A1 is 1.006 [0.964, 1.049] over sets R and N, $333.00
against $331.10. This is round 3's H3. No kind shows a change except teach, 1.054 [1.0005, 1.111], p 0.048,
which is $5.97 more.

There is cost headroom on Opus, and hippo takes none of it. A4, the taught rule written straight into
`CLAUDE.md`, costs 0.928 [0.888, 0.969] of built-in memory, p 0.001, $16.60 less on $229.10 (seeds 1 and 2). On
the same seeds hippo is 1.003 [0.957, 1.050]. Base prereg line 192 asks this question: "how much memory value is
still on the table?" For cost, the answer is about 7%.

The read can see what memory is worth. With no memory, A0 costs 1.156 [1.093, 1.223] of built-in memory over sets
R and N (seeds 1 and 2). On later applies the no-memory arm costs 1.821 [1.574, 2.107], $27.79 more, and solves
16.7 points fewer tasks. So a lesson that changes behaviour shows up as a lower cost on the apply tasks.

## The first apply shows no change

On the first apply, the point estimates of hippo and sham hippo are both below built-in memory, but both intervals
cross 1:
A2/A1 0.834 [0.664, 1.047], A5/A1 0.829 [0.682, 1.008]. Compared directly, A2/A5 is 1.005 [0.871, 1.160]. So the
data does not show a first-apply saving, and it does not say whether hippo's lessons or its seeded block cause
any part of it.

## What the script does

1. It checks the sha256 of the 10 analyzer sources and of every input (35 runs, 35 plans, prices, grading, drop
   list) against the hashes in `C:/z0-runs/scored/r3-final/unblind.json`. Grading and drop list default to the
   copies in `docs/evals/z0-r3/`, because the report's own paths name a deleted worktree.
2. It runs the analyzer's own `loadInputs`, `filterRecords`, `taskUnits` and `harmT`, at the Opus 5.5 list prices
   of the `claude-code` block in the prices file.
3. It stops unless three lines of round 3's report come out exact in every field: H3 1.006 [0.964, 1.049],
   maintainer-only H3 0.995 [0.948, 1.044], and H4 (set N cost ratio 1.009 [0.978, 1.040] and resolve difference).
4. It prints 35 cells: seven arm pairs, each over sets R and N and over four kinds. The kinds are teach, first
   apply, later apply (the second apply and after) and set N. It stops if the four kinds do not sum to sets R and
   N, or if the two arms of a pair disagree on a task's set, kind or apply slot.

A0 and A4 ran two seeds (base prereg line 124), so their pairs use seeds 1 and 2 only. To compare like with like,
the script also prints A2/A1 and A5/A1 on seeds 1 and 2.

## Cells

Cost is the ratio of the arm's summed cost to the control's, with the fixed-repository t interval. Dollars are the
summed costs at list price. Resolve is the difference in round 3's resolved flag (acceptance passed, every lesson
check passed, no timeout), so on set R it includes lesson compliance.

| Pair | Seeds | Kind | Units | Cost ratio [95% CI] | p | $ arm | $ control | $ diff | Resolve diff [95% CI] |
|---|---|---|---|---|---|---|---|---|---|
| A2/A1 | all | sets R+N | 995 | 1.006 [0.964, 1.049] | 0.791 | 333.00 | 331.10 | +1.90 | +0.005 [-0.007, +0.017] |
| A2/A1 | all | teach | 189 | 1.054 [1.0005, 1.111] | 0.048 | 116.09 | 110.12 | +5.97 | +0.017 [-0.012, +0.046] |
| A2/A1 | all | first apply | 148 | 0.834 [0.664, 1.047] | 0.112 | 40.66 | 48.77 | -8.12 | +0.042 [-0.008, +0.091] |
| A2/A1 | all | later apply | 184 | 1.062 [0.977, 1.153] | 0.150 | 51.51 | 48.52 | +2.99 | +0.003 [-0.047, +0.053] |
| A2/A1 | all | set N | 474 | 1.009 [0.978, 1.040] | 0.584 | 124.74 | 123.69 | +1.06 | +0.000 |
| A5/A1 | all | sets R+N | 995 | 0.968 [0.933, 1.005] | 0.087 | 320.55 | 331.10 | -10.56 | +0.009 [-0.001, +0.019] |
| A5/A1 | all | teach | 189 | 0.987 [0.943, 1.033] | 0.559 | 108.67 | 110.12 | -1.45 | -0.003 [-0.033, +0.028] |
| A5/A1 | all | first apply | 148 | 0.829 [0.682, 1.008] | 0.060 | 40.45 | 48.77 | -8.32 | +0.045 [-0.015, +0.104] |
| A5/A1 | all | later apply | 184 | 0.982 [0.899, 1.073] | 0.682 | 47.66 | 48.52 | -0.86 | +0.025 [-0.021, +0.072] |
| A5/A1 | all | set N | 474 | 1.001 [0.971, 1.032] | 0.969 | 123.77 | 123.69 | +0.07 | +0.006 |
| A2/A5 | all | sets R+N | 994 | 1.039 [1.008, 1.070] | 0.013 | 332.79 | 320.38 | +12.41 | -0.004 [-0.013, +0.006] |
| A2/A5 | all | teach | 189 | 1.068 [1.011, 1.129] | 0.021 | 116.09 | 108.67 | +7.42 | +0.020 [-0.016, +0.056] |
| A2/A5 | all | first apply | 148 | 1.005 [0.871, 1.160] | 0.944 | 40.66 | 40.45 | +0.20 | -0.003 [-0.026, +0.020] |
| A2/A5 | all | later apply | 184 | 1.081 [0.982, 1.190] | 0.109 | 51.51 | 47.66 | +3.85 | -0.022 [-0.074, +0.029] |
| A2/A5 | all | set N | 473 | 1.008 [0.974, 1.043] | 0.659 | 124.54 | 123.60 | +0.94 | -0.006 |
| A4/A1 | 1-2 | sets R+N | 677 | 0.928 [0.888, 0.969] | 0.001 | 212.50 | 229.10 | -16.60 | +0.010 [-0.005, +0.024] |
| A4/A1 | 1-2 | teach | 129 | 0.924 [0.865, 0.988] | 0.022 | 71.64 | 77.49 | -5.85 | +0.013 [-0.023, +0.049] |
| A4/A1 | 1-2 | first apply | 101 | 0.773 [0.566, 1.056] | 0.077 | 26.06 | 33.70 | -7.64 | +0.057 [-0.006, +0.119] |
| A4/A1 | 1-2 | later apply | 123 | 0.928 [0.806, 1.068] | 0.281 | 31.41 | 33.86 | -2.44 | +0.040 [+0.007, +0.074] |
| A4/A1 | 1-2 | set N | 324 | 0.992 [0.959, 1.026] | 0.648 | 83.40 | 84.05 | -0.66 | +0.000 |
| A0/A1 | 1-2 | sets R+N | 674 | 1.156 [1.093, 1.223] | <0.001 | 264.28 | 228.55 | +35.74 | -0.024 [-0.045, -0.004] |
| A0/A1 | 1-2 | teach | 129 | 0.970 [0.900, 1.046] | 0.410 | 75.19 | 77.49 | -2.30 | +0.016 [-0.032, +0.064] |
| A0/A1 | 1-2 | first apply | 101 | 1.364 [1.066, 1.746] | 0.017 | 45.97 | 33.70 | +12.27 | -0.235 [-0.346, -0.124] |
| A0/A1 | 1-2 | later apply | 123 | 1.821 [1.574, 2.107] | <0.001 | 61.65 | 33.86 | +27.79 | -0.167 [-0.278, -0.056] |
| A0/A1 | 1-2 | set N | 321 | 0.976 [0.938, 1.016] | 0.228 | 81.48 | 83.50 | -2.02 | +0.003 |
| A2/A1 | 1-2 | sets R+N | 676 | 1.003 [0.957, 1.050] | 0.905 | 229.55 | 228.91 | +0.65 | +0.010 [-0.003, +0.022] |
| A2/A1 | 1-2 | teach | 129 | 1.031 [0.964, 1.102] | 0.356 | 79.89 | 77.49 | +2.41 | +0.029 [+0.000, +0.057] |
| A2/A1 | 1-2 | first apply | 101 | 0.835 [0.661, 1.055] | 0.123 | 28.14 | 33.70 | -5.56 | +0.039 [-0.005, +0.082] |
| A2/A1 | 1-2 | later apply | 123 | 1.068 [0.955, 1.195] | 0.236 | 36.17 | 33.86 | +2.32 | +0.000 [-0.047, +0.047] |
| A2/A1 | 1-2 | set N | 323 | 1.018 [0.985, 1.052] | 0.293 | 85.35 | 83.87 | +1.48 | +0.006 |
| A5/A1 | 1-2 | sets R+N | 675 | 0.960 [0.920, 1.002] | 0.061 | 219.65 | 228.74 | -9.09 | +0.010 [-0.002, +0.022] |
| A5/A1 | 1-2 | teach | 129 | 0.975 [0.922, 1.031] | 0.342 | 75.55 | 77.49 | -1.94 | -0.009 [-0.044, +0.027] |
| A5/A1 | 1-2 | first apply | 101 | 0.837 [0.678, 1.033] | 0.094 | 28.21 | 33.70 | -5.48 | +0.048 [-0.020, +0.115] |
| A5/A1 | 1-2 | later apply | 123 | 0.963 [0.862, 1.077] | 0.498 | 32.62 | 33.86 | -1.24 | +0.033 [-0.038, +0.103] |
| A5/A1 | 1-2 | set N | 322 | 0.995 [0.963, 1.028] | 0.757 | 83.27 | 83.70 | -0.43 | +0.006 |

The set N resolve intervals are left out of this table; `--json` prints them.

## Limits

- **Exploratory.** 35 cells with p not adjusted. At p below 0.05, about 2 of 35 cells pass by chance alone.
- **One model.** Every arm ran on `claude-opus-5-5` (`pins-r3c.json`). This read says nothing about a cheaper model.
- **A4 is two changes at once.** A4 is A0 plus the taught rule, so its auto memory is off (base prereg line 82). Its
  saving mixes a delivered lesson with no built-in memory overhead. A0/A1 teach, 0.970 [0.900, 1.046], shows no
  change, so this read cannot split the two.
- **Two-seed pairs.** A0 and A4 have seeds 1 and 2 only, and their cells are the thinnest (101 to 129 units on set
  R kinds).
- **Positions differ a little across pairs.** Each pair is matched, but different pairs sit on nearly the same
  positions, not identical ones (677 units for A4/A1, 676 for A2/A1 on seeds 1 and 2).
- **List prices.** Costs use the Opus 5.5 list prices in the round 3 prices file, not a bill.

## What this means for round 4

- **Capture is the direct cost lever.** It costs 3.9% over sham hippo, and teach tasks carry 60% of those dollars
  ($7.42 of $12.41). A cheaper capture step can save that without any change to recall.
- **Delivery is the larger lever.** A rule that reaches the model saves about 7% on Opus, and hippo takes none of
  that today. The size of hippo's injected block is not the lever: the hook diet replay put the whole cut at about
  1.5% (`2026-11-09-z0-round3-hook-diet-replay.md`).
- **A cheaper model needs its own control.** A cheaper model costs less per token on its own, so a test of hippo on
  Sonnet against built-in memory on Opus must also run Sonnet with built-in memory alone. A0/A1 shows that missing
  memory costs most on the apply tasks. A weaker model can repeat a mistake more often, so a delivered lesson can
  have more to save there. That is a hypothesis for round 4 to test, not a result of this read.
