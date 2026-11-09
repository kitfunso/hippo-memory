# Z0 round 3 hook diet replay: what `pinnedInject.excludeTags` saves

Date: 9 Nov 2026. Build read: hippo master at `0402d3daa`, the first build with `pinnedInject.excludeTags` (PR #1183).
Inputs: the 35 runs of the round 3 final read (`C:/z0-runs/scored/r3-final-read.sh` lines 8 to 15), through
`runNames` in `scripts/token-eval/z0-reach.mjs`. Script:
`node scripts/token-eval/z0-hook-diet.mjs --scored C:/z0-runs/scored` (add `--json` for one JSON object). The run
makes no model calls and costs nothing. This is a model-free read of round 3's saved stores, not a scored run.

## Answer

The longest exclude list cuts hippo's prompt block by 77% of its tokens. That saves about 1.5% of an A2 session's
cost, $0.0039 of $0.257. Round 3 already ties built-in memory on cost per solved task: A2 $0.365 against A1 $0.368
(`C:/z0-runs/scored/r3-final/unblind.json`, `reported.perArm.A1|A2.costPerResolved.estimate`). H3's cost ratio is
1.006 [0.964, 1.049] (`unblind.stdout` line 25). A 1.5% saving sits well inside that interval, so this cut alone
cannot show a cost win at round 3's size. A cost win needs a lever on the turns a session takes or on the tasks it
solves.

## What the script does

For each A2 seed, round 3 saved hippo's stores as they stood before the seed's last A2 session
(`r3run/<run>/run/snap/<task>/A2/seed<k>/pre-session/`). The script copies those stores to a temp folder and runs
the real prompt hook on them, `hippo context --pinned-only --include-recent 5 --format additional-context`, with the
session's own first prompt. It renders each store in three arms:

| Arm | `pinnedInject.excludeTags` |
|---|---|
| none | not set (what round 3 ran) |
| digest | `session-digest` |
| list3 | `session-digest`, `claude-code-memory`, `auto-captured` |

Each render runs with the allowlist env of `hippo-iso.sh` and a fake home, so no shell setting reaches it. By
default each render runs at its session's start time: `HIPPO_FAKE_NOW` is the `at` stamp of the first line of the
session's request log (the proxy's `HEAD /api/hello`). `--clock wall` runs at the wall clock instead.

## Fidelity: the replay shows what round 3 sent

The script compares the none arm with the hippo block that round 3 put in the session's first request, read by
`extractSession` in `z0-reach.mjs`. A match means the same section headers, entry counts and token counts.

| Clock | Stores | Rendered | Recorded block | Exact match |
|---|---|---|---|---|
| session (default) | 91 | 81 | 76 | 75 |
| wall | 91 | 81 | 76 | 63 |

10 stores have no first prompt in their request log, so the script skips them. In the other 5 rendered sessions,
round 3 sent no memory section, and the replay renders none too. The one session that differs, `q254-w1` seed 2
(`q254-f2-a2`), has the same 5 entries at 859 tokens against 898 recorded. Its cause is not known.

The clock matters: run at today's date, 12 blocks change, because decay and recency scoring read the clock. So the
session clock is the default, and every figure below comes from that run.

## Block size by arm

Tokens are hippo's own header estimate (characters divided by 4), summed over the memory sections. The "Rules from
the user" section is left out, because no arm changes it.

| Arm | Mean tokens | Median | Empty blocks | Cut against none |
|---|---|---|---|---|
| none | 496.4 | 497.0 | 0 | |
| digest | 163.2 | 91.0 | 4 | 67.1% |
| list3 | 113.3 | 62.0 | 4 | 77.2% |

By characters of the whole block, the rules section included, the cuts are 53.4% (digest) and 61.4% (list3).

## Against real session cost

The block sits in the session's first user turn. Claude Code writes it to the prompt cache once, then reads it from
the cache on each later main call (a call with more than 3 tools, as `isMainCall` in `z0-reach.mjs` defines). The
saving per session is `cut x (cache write price + (main calls - 1) x cache read price)`, at the Opus 5.5 prices in
`C:/z0-runs/s7/prices.json` ($8 a million tokens to write, $0.20 to read). The 5 sessions that round 3 sent no block
are left out, so n is 76.

| | digest | list3 |
|---|---|---|
| Saving per session | $0.00337 | $0.00387 |
| Share of mean session cost ($0.2567) | 1.31% | 1.51% |
| Share of cache-read tokens | 0.70% | 0.81% |

Those 76 sessions average 8.5 main calls with the block, 9.1 turns and 373,488 cache-read tokens.

## Limits

- **The sample leans to large stores.** Each seed's snapshot is the store before its last A2 session, where the
  store is largest. A mean A2 session has a smaller block, so its saving is likely smaller still.
- **Tokens are hippo's estimate.** The cut is in hippo's character-based count, not in API tokens.
- **Only the block's own tokens count.** The replay cannot show whether a smaller block changes what the agent does,
  how many turns it takes or whether it solves the task. Only a scored run can show that.

## What this means for round 4

A round 4 cost test built on this cut alone would need a run several times round 3's size to separate a 1.5% saving
from noise. Round 3's measured benefit is 14.9 points fewer repeat mistakes at the same cost
(`2026-11-08-z0-round3-result.md`). A repeat mistake costs turns. So this read recommends that round 4's cost test aim
at the turns that repeat mistakes cost, with the list3 cut as an extra arm. The round 4 prereg makes that choice.
