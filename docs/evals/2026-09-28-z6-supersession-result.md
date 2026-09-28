# Z6 automatic supersession, shipped baseline: result

**Date:** 2026-09-28. **Pre-registration:** `docs/evals/2026-09-28-z6-supersession-prereg.md`, locked at `24f4b5c` before any scored run. **Verdict: FAIL** on the Z6 test-first bar, as predicted, in both full runs.

## Answer

No change scenario passes in any arm: there is not one `d`. The capture arm, the primary one, scores `d` on 0 of 20 held-out change scenarios (95% Wilson interval 0.000 to 0.161). All 40 capture-arm change scenarios stop at the first stage, `a`: capture never stored both versions.

The build should fix capture (`a`) first. The remember arm, which stores every version, orders the stages behind it. Sleep removes one version and records no retirement (`x`, 26 of 40). Nothing retires the old version in the rest (`b` or `c`, 14 of 40). Even an explicit supersede shows no reason (`d0`, 40 of 40 in the oracle arm).

## Pins

- Code measured: master `94a1f46`. Last commit to change `src/`: `e58ff49`. `package.json`: 1.52.6.
- Both runs ran at `24f4b5c`, the lock commit. No file under `src/` changed after the pin.
- `dist/` SHA-256: `6f290a282909356a1c14db73ff8cef48285bf8680d539fe4c8fc3505fe0a7392`.
- Fixture SHA-256: `652963502a5205eb64741064ab29e7cf931038b83d3a6e93866098c52b056f95`.
- Results: `benchmarks/z6-supersession/results.json` (run 1) and `benchmarks/z6-supersession/results-run2.json` (run 2). Both record the same pins.
- Selftest: 269 checks pass at the lock commit.

## Verdict and validity

- The bar: capture `d` on at least 18 of 20 held-out change scenarios; no held-out capture-arm control fails and at least 4 of 5 pass; no filler memory retired or lost across the 25 held-out capture-arm runs.
- Both runs: `FAIL (capture d on 0/20 held-out change scenarios; held-out capture-arm controls passed 1/5, need 4)`. The filler part held (0 retired, 0 lost), and no held-out capture-arm control failed.
- Oracle check: 40 of 40 change scenarios are `d0` with both versions reached, against a void line of 36. In all 40 the old memory is retired and linked to the current one by `superseded_by`, no link dangles, and no retired memory is shown. Only the reason test fails, as the pre-registration predicts: explain prints no reason.
- Second run: same verdict, same reasons. Two per-scenario labels differ (see Run-to-run differences); the pre-registration reports such changes and does not void on them.
- The script checks the other retraction conditions as it runs and stops on any breach (`scripts/z6-supersession-eval.mjs:189-487`): temp folder and git work tree, a fresh store, the seven hooks, paid keys, embedding packages, hippo exit codes, the daily-run closing line, worker timeouts and log lines, and BM25-only explain. Both runs finished all 180 scenario-arm runs and exited 0.

## Labels by arm

Change scenarios only. Run 2 in brackets where it differs.

| Arm | Split | `a` | `x` | `d` | `d0` | `s` | `n` | `c` | `b` | Pass (`d`) |
|---|---|---|---|---|---|---|---|---|---|---|
| capture | held-out | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/20 |
| capture | tune | 20 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/20 |
| remember | held-out | 0 | 12 | 0 | 0 | 0 | 0 | 4 [3] | 4 [5] | 0/20 |
| remember | tune | 0 | 14 | 0 | 0 | 0 | 0 | 1 [0] | 5 [6] | 0/20 |
| oracle | held-out | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 0/20 |
| oracle | tune | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 0/20 |
| oracle-sleep | held-out | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 0/20 |
| oracle-sleep | tune | 0 | 0 | 0 | 20 | 0 | 0 | 0 | 0 | 0/20 |

- Both versions stored (every label but `a`): capture 0 of 40, remember, oracle and oracle-sleep 40 of 40. The pass rate among them is 0 in every arm.
- Remember arm by category (all 40, run 1): move `x` 9, `b` 1; flip `x` 9, `b` 1; correction `x` 8, `b` 2; reversal `c` 5, `b` 5 [`c` 3, `b` 7]. By domain: personal `x` 14, `c` 3, `b` 3; coding `x` 12, `c` 2, `b` 6 [`c` 0, `b` 8]. The capture arm is `a` in every category and domain.
- Per surface, remember arm (all 40, run 1): context hook `x` 26, `c` 11, `b` 3 [`c` 8, `b` 6]; `context --auto` `x` 26, `s` 3, `n` 3, `c` 6, `b` 2; recall `x` 26, `c` 10, `b` 4. Oracle: `d0` on every surface in all 40. Oracle-sleep: `d0` on the context hook and recall in all 40; on `context --auto`, `d0` in 8 (all reversals) and `n` in 32.

## Per scenario

Held-out first. Remember and oracle-sleep show the union label, then the context hook, `context --auto` and recall labels. A dash means not run: the oracle arms run change scenarios only. Run 2 is shown only where it differs.

| Scenario | Split | Category | Domain | Capture | Remember (context, auto, recall) | Oracle | Oracle-sleep (context, auto, recall) |
|---|---|---|---|---|---|---|---|
| `z6-1e67119a` | held-out | move | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-1eaff37f` | held-out | move | coding | `a` | `b (c, s, b)` | `d0` | `d0 (d0, n, d0)` |
| `z6-b6888049` | held-out | move | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-0204b855` | held-out | move | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-e5326a57` | held-out | move | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-06730bed` | held-out | flip | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-77f459da` | held-out | flip | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-a9a70f33` | held-out | flip | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-c984d366` | held-out | flip | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-ecd34ab1` | held-out | flip | personal | `a` | `b (c, b, c)` | `d0` | `d0 (d0, n, d0)` |
| `z6-312d14d1` | held-out | correction | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-5c233222` | held-out | correction | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-61813313` | held-out | correction | coding | `a` | `b (c, s, b)` | `d0` | `d0 (d0, n, d0)` |
| `z6-865c9e7e` | held-out | correction | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-9a67f155` | held-out | correction | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-7316c4cb` | held-out | reversal | coding | `a` | `b (b, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-e79680bc` | held-out | reversal | coding | `a` | `c (c, n, c)`; run 2: `b (b, n, c)` | `d0` | `d0 (d0, n, d0)` |
| `z6-033b556b` | held-out | reversal | personal | `a` | `c (c, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-0b049b2b` | held-out | reversal | personal | `a` | `c (c, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-2ab99e85` | held-out | reversal | personal | `a` | `c (c, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-ca918114` | held-out | restate control | coding | `pass` | `pass` | - | - |
| `z6-4131e9d7` | held-out | restate control | personal | `n/a` | `pass` | - | - |
| `z6-5e55d15e` | held-out | look-alike control | coding | `n/a` | `fail` | - | - |
| `z6-a5780c09` | held-out | look-alike control | coding | `n/a` | `fail` | - | - |
| `z6-c179cb01` | held-out | look-alike control | personal | `n/a` | `fail` | - | - |
| `z6-c6633efe` | tune | move | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-efccd58e` | tune | move | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-3a3dbfbf` | tune | move | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-4237d1cb` | tune | move | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-b5583883` | tune | move | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-4d6245e5` | tune | flip | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-7973a8d5` | tune | flip | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-e4c92ec3` | tune | flip | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-52e26c0c` | tune | flip | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-5f25f7c4` | tune | flip | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-39883550` | tune | correction | coding | `a` | `b (c, s, b)` | `d0` | `d0 (d0, n, d0)` |
| `z6-4fbb4829` | tune | correction | coding | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-31dbcb4b` | tune | correction | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-34f96edd` | tune | correction | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-8a614210` | tune | correction | personal | `a` | `x (x, x, x)` | `d0` | `d0 (d0, n, d0)` |
| `z6-6bde2c89` | tune | reversal | coding | `a` | `c (c, n, c)`; run 2: `b (b, n, c)` | `d0` | `d0 (d0, n, d0)` |
| `z6-8264dba4` | tune | reversal | coding | `a` | `b (b, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-8b946ddc` | tune | reversal | coding | `a` | `b (b, c, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-677ce811` | tune | reversal | personal | `a` | `b (c, n, b)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-cb159bbe` | tune | reversal | personal | `a` | `b (c, b, c)`; run 2: `b (b, b, c)` | `d0` | `d0 (d0, d0, d0)` |
| `z6-4c3cc894` | tune | restate control | coding | `n/a` | `pass` | - | - |
| `z6-6827c21e` | tune | restate control | personal | `n/a` | `pass` | - | - |
| `z6-ddffe9c3` | tune | restate control | personal | `n/a` | `pass` | - | - |
| `z6-346c3b9f` | tune | look-alike control | coding | `n/a` | `fail` | - | - |
| `z6-fd5204a9` | tune | look-alike control | personal | `n/a` | `fail` | - | - |

In the capture arm, 38 of the 40 change scenarios stored neither version. `z6-7973a8d5` stored the current version and not the old one. `z6-865c9e7e` stored a clause from the old session without its marker, and nothing from the current one.

## The stages

**`a`: capture stores nothing (capture arm, 40 of 40).** Of the 110 statement sessions, change and control, the capture worker logged "No actionable items found" for 104 and stored an item for 6, one of them without the statement's marker. That is the count the pre-registration made before the lock from capture's own extraction. No change scenario had both versions stored.

**`x`: sleep removes a version and records no retirement (remember arm, 26 of 40).** The remember arm stores every version. By the question, 26 scenarios have no copy left of one version: 23 through merge fade and 3 through dedup. Each daily sleep merges the same old and current pair again and cuts both half-lives again, until the raw memories go dormant and one derived memory is left, holding the longer text (pre-registration, (a)).

- In 20 (18 of the 20 moves and flips, and 2 corrections) the old version is gone and the current one survives in the derived memory. The right fact is left, by text length, and nothing says it replaced anything.
- In 6, all corrections, the current version is gone and only the corrected fact is left: `z6-31dbcb4b`, `z6-34f96edd` and `z6-4fbb4829` (tune) through merge fade, and `z6-312d14d1`, `z6-5c233222` and `z6-9a67f155` (held-out) through dedup. In `z6-312d14d1` the user corrects the dev server port from 3000 to 5173. Dedup deletes the 5173 memory and keeps the older 3000 one, since it picks the survivor by strength, retrieval count and content order, never by age (pre-registration, (a)), and the derived memory also reads 3000. So 6 of the 10 corrections end with hippo holding only the fact the user corrected.

**`b` and `c`: both versions stay active (remember arm, 14 of 40).** These are all 10 reversals, plus 1 move, 1 flip and 2 corrections. No memory of any kind was retired in the capture or remember arms, and sleep's conflict detector opened no row between an old and a current memory in any of the 40 scenarios. In 5 (`c`, run 1) the current version beats the old one on every surface that shows the old one. In 9 (`b`) the old one is shown on some surface where the current one does not beat it. `context --auto`, the command hippo's `CLAUDE.md` block tells the agent to run at task start, showed only the old version in 3: `z6-1eaff37f`, `z6-61813313` and `z6-39883550`.

**`d0`: no reason (oracle arm, 40 of 40).** After an explicit `hippo supersede`, the old memory is retired, linked and hidden on every surface, and the current one is shown. Only the reason test fails. The oracle-sleep arm adds the interleave notes and 10 or 15 daily runs, and the retirement and its link survive in all 40. There, `context --auto` showed the current memory in 8 of 40 (all reversals), against 40 of 40 without the daily runs; the context hook and recall showed it in all 40. Why the daily runs push it out of auto's fill is not examined here. The pre-registration already calls auto's pick among fresh memories close to arbitrary.

## Controls

- **Capture arm.** 1 of 10 is evaluable: only `z6-ca918114`, a held-out restatement, had both statements stored, and it passed. The other 9 are `n/a` because capture stored at most one statement. No control failed, and none opened a conflict row. The bar's control part fails because too few controls were stored to score.
- **Remember arm.** All 10 are evaluable. The 5 restatements pass. The 5 look-alikes fail, each through a lost value and none through a retirement. In each, the two facts about different subjects merged into one derived memory holding only the longer text, in all five the second statement's. By the question neither raw memory is left, so the first subject's fact is gone. In `z6-5e55d15e`, "The staging service listens on port 4400." and "The analytics service listens on port 7700." leave only the 7700 memory. The results record no cause for a control's loss; this reading comes from the traces (see Deviations), and it matches the merge fade above.
- A likely consequence for the build, not measured here: once capture stores both look-alike statements, the same merge would lose one of them, and the bar fails on any failed held-out capture-arm control, whatever supersession does.

## Diagnostics

Remember arm, run 1, unless stated. Run 2 in brackets where it differs.

- **Derived memories.** 39 of 40 scenarios end with one derived memory for the pair. It holds only the old text in 15 and only the current text in 24, never both (both runs).
- **Dedup.** 43 deletions hit an old or current memory [48]. In 6, in both runs, the survivor was older and held the other value: the 3 held-out corrections above and 3 `b` scenarios. The rest kept a newer copy of the same value, which fits each sleep writing a fresh derived copy of the pair and dedup deleting the previous one.
- **Memories lost by the question** (memories, not scenarios): old versions 13 through dedup and 32 through merge fade [18 and 32]; current versions 30 through dedup and 32 through merge fade. None through another forget, plain dormancy or an unrecorded loss.
- **Reach** (explain lists both versions): capture 0, remember 14 (the scenarios that kept both), oracle and oracle-sleep 40, each of 40.
- **Echoes, dangling links, retired-but-shown:** 0 in every arm.
- **Filler:** 0 retired and 0 lost in every arm and split. Active filler memories at the question, summed over all runs in the arm: capture 5,822, remember 5,674 [5,671], oracle 3,920, oracle-sleep 4,550.

## Run-to-run differences

Two full runs on the same code and fixture, side by side. Capture, oracle and oracle-sleep labels match on every scenario and every surface. In the remember arm, 2 union labels differ: `z6-e79680bc` (held-out) and `z6-6bde2c89` (tune), `c` in run 1 and `b` in run 2. A third, `z6-cb159bbe` (tune), differs on the context hook only (`c`, then `b`); its union label is `b` in both. All three are reversals, and all three changes are on the context hook. That hook lists the five newest memories and orders memories written in the same millisecond by a random id (`src/api.ts:2787-2790`).

## Deviations from the pre-registration

None in the procedure, the labels or the bar. What differs from the text, or goes beyond it:

1. The pre-registration says every label reports `sRetired`. The locked script computes it only for labels past `x` (`scripts/z6-supersession-eval.mjs:607-638`), so the `a` and `x` rows in the results carry no `sRetired`. The traces fill the gap: no memory of any kind was retired in the capture or remember arms, in either run.
2. The two full runs ran at the same time on one machine: run 1 under the default base `hz6q`, run 2 under `--root-base hz6r`. The pre-registration's Fixed path allows this. The last four path segments, and so the path tags, are the same in both.
3. Both runs also wrote a `--trace` file. It adds one line per scenario and arm and changes nothing else (`scripts/z6-supersession-eval.mjs:816-822`). Traces hold memory text and are not committed.
4. Run 2 wrote its results with `--out`. They are committed as `results-run2.json`, so the second-run check can be read from the repo.
5. The control-loss reading, the two example scenarios above and the retired-memory count come from the traces, since the results hold no memory text and no cause for a control's loss.

## Order for the build

1. **`a`, capture. Fix first.** 40 of 40 capture-arm change scenarios stop here, and 9 of 10 capture-arm controls cannot be scored. Nothing later can be measured on the zero-touch path until capture stores both versions.
2. **`x`, keep both versions until one is retired.** 26 of 40 in the remember arm, 6 of them corrections that lose the current fact. Merge keeps folding the same pair until both raw memories fade, and dedup can keep the older copy. The same merge loses a fact in all 5 look-alike controls.
3. **`b` and `c`, retire the old version.** 14 of 40 keep both versions active. Nothing retires the old one, and the conflict detector saw none of the 40 pairs.
4. **`d0`, show the reason.** Even an explicit supersede reaches only `d0`, 40 of 40, because explain prints no reason. The ROADMAP's Show-it checks (the retired fact's date, source and rule) go on top of this.

The remember arm stores each statement's one-sentence `fact`, while capture stores a clause of the user's sentence. So once capture works, its pairs may merge more or less often than here; stages 2 to 4 should be measured again on the capture arm, on the held-out split.

## Reproduce

```
npm ci
npm run build
node scripts/z6-supersession-eval.mjs --selftest
node scripts/z6-supersession-eval.mjs
node scripts/z6-supersession-eval.mjs --root-base <temp folder>/hz6r --out <file>
node scripts/z6-supersession-eval.mjs --compare benchmarks/z6-supersession/results.json <file>
```

The second run's `--root-base` must sit inside the system temp folder. The scenario runs summed to about 24 minutes per full run here.
