# Micro-eval: five red fixtures, fixed at the source

Date: 2026-09-05. Episode `01M1SQ7AD1N4AJKQBMT1AX1DKR` (A3 item 12).

## Problem

`python benchmarks/micro/run.py` on a fresh `npm ci` of `d3c77ba` reports
overall 0.744 with six failing fixtures: dlpfc-goals, ofc-utility,
pineal-salience, reranker-cross-encoder, vmpfc-value and path-boost. Nothing
flagged them because the micro-eval is not in CI. The A3 acceptance is: per
fixture, decide regression versus stale fixture from the git history of the
mechanic, fix at the source (src or fixture, never a skip-list), 13/13, then
decide whether the micro-eval belongs in CI.

## Findings, per fixture

| Fixture | Verdict | Evidence |
|---|---|---|
| dlpfc-goals, pineal-salience, reranker-cross-encoder, vmpfc-value | Harness gap, not a regression | All four calibrated while `@xenova/transformers` (then `@huggingface/transformers`) was an auto-installed optionalDependency (`1a47172`..`4beba24`). PR #134 (`4ce21e7`, 2026-07-28) moved it to `peerDependenciesMeta` so a fresh `npm ci` is BM25-only and the cross-encoder silently falls back to identity order (`src/rerankers/cross-encoder.ts:122-123`). With `npm install --no-save @huggingface/transformers` all four pass. |
| ofc-utility | Stale calibration | With the backend present the `--rerank-utility` flip sits on a knife-edge: raw score verbose 0.08842 vs lengthy 0.06642, ratio 1.331; the token penalties (0.70 vs 0.9229) flip the order only when the ratio is below 1.318. Same recalibration shape as vmpfc on 2026-07-09. |
| path-boost | Harness premise broken by PR #168 | `getHippoRoot` now walks up to the nearest ancestor store, bounded by `os.homedir()` and the temp root (`src/project-identity.ts:136-170`). The runner sandbox "home" is a temp subdir, so `hippo init` in `home/proj-nova/lib` reuses `home/.hippo` and creates no nested store (probe: only `home/.hippo/hippo.db` exists afterwards). All three competitors then live in one local store and the promoted global rows lose to the local gravemark copy (bm25 2.836 vs 1.716). The docstring at `run.py:216-221` still claims "no ancestor walk-up". |

## Fixes

1. `benchmarks/micro/run.py`
   - `run_hippo` sets `HOME` and `USERPROFILE` to the sandbox home so the hippo home boundary applies. The sandbox models the user home dir, which is exactly what `findHippoStoreDir` treats as the top of a walk. Docstring at `_resolve_item_cwd` rewritten to say so.
   - `preflight_embeddings()` runs once before the fixture loop in a throwaway home: `init`, one `remember`, then `recall --json --why --reranker cross-encoder`. It refuses to run when the probe row has no numeric `cosine` (no embedding was computed) or stderr carries the cross-encoder fallback warning from `src/rerankers/cross-encoder.ts:122-123` (weights did not load). These are the code paths the fixtures themselves use, so a package that imports but cannot fetch weights fails here instead of as a silent identity fallback. `hippo status` was rejected as the signal: it only proves the package resolves, and its line is padded human text with no `--json`. No flag to run BM25-only: every ranking fixture was calibrated with embeddings, so a BM25-only pass rate is not a result.
   - Every reader of the home directory in `src/` under the override (grep `homedir|env.HOME|env.USERPROFILE`): `project-identity.ts:107,164` (identity and store walk, the intended effect: the sandbox root becomes user-global instead of a project named `hippo-micro-<fixture>-<rand>`); `project-identity.ts:227` and `db.ts:2176` (`originFromSource` classifies `shared:`/`promoted:` rows against the home basename; path-boost is the only fixture with promote actions, and its rows promoted from the sandbox root now classify as user-global, which is the real-world semantics for a home store; `db.ts:2176` is the v39 backfill for legacy NULL rows and never fires on a fresh store); `project-identity.ts:201` (global root fallback, unused because `HIPPO_HOME` is set); `hooks.ts:207` and `capture.ts:743` (hook install and `hippo capture`, neither run by the harness: `--no-hooks`, no capture action); `postinstall.ts:49` (npm lifecycle, not the CLI); `cli.ts:502,2741,3428` (the `init --scan` default, the `learnFromMemoryMd` default reached from `sleep` without `--no-learn`, and the codex session-end worker's `--codex-home` default: none reached by the harness today, which never passes `--scan`, never runs `sleep`, and never calls the worker; a future fixture that does would read the sandbox, which is the intended sandbox semantics). Behavioural check: 13/13 with the override, path-boost included.
2. `benchmarks/micro/fixtures/ofc_utility.json`: the verbose memory drops from 12 to 8 on-topic sentences (filler unchanged, still about 3.1k tokens so its penalty stays capped at 0.30). Measured ratio 1.179, mid-window between the no-flag floor (1.0) and the flip ceiling (1.318), a margin of 0.14 to 0.18 on each side where the old calibration had none. Measured on Windows with Node 24; the CI job on ubuntu is the cross-platform check, and BM25 here is the hippo tokenizer, not a platform library. Sweep: 10, 8, 6, 4 all pass; shortening the lengthy memory instead leaks it into the no-flag top-3 at every length tried (40, 25, 15, 8 filler sentences).
3. CI: yes, as its own job `micro-eval` in `.github/workflows/ci.yml`. It installs `@huggingface/transformers@4.2.0` with `--no-save` (the version the fixtures were recalibrated against), caches `node_modules/@huggingface/transformers/.cache` (175 MB of MiniLM + ms-marco weights) under a key naming that version plus a hash of the two files that name the models, and runs the full micro-eval. No `restore-keys`: a partial hit would serve weights from another layout. Required status check: master has no branch protection today (`gh api repos/kitfunso/hippo/branches/master/protection` returns 404), so neither `test` nor `micro-eval` blocks a merge; both gate through the deploy ritual (`gh pr checks` before merge). Making them required is a repo setting, filed in `TODOS.md` for Keith. Rationale: the five fixtures rotted for up to four months because nothing ran them; a separate job keeps the `test` job timing and the zero-dep default install untouched. The `test` job comment that claims the transformers install happens in CI is wrong since #134 and is corrected.
4. `benchmarks/micro/README.md`: requirements paragraph (backend needed, install command, the preflight refuses otherwise).
5. `CHANGELOG.md` under `## 1.38.3 - unreleased`. Version bump at the batch gate.
6. `TODOS.md` follow-up, not fixed here: `hippo init` inside a directory that already has an ancestor store prints `Already initialized at <ancestor>` and creates nothing. `git init` in the same position creates a nested repo. Product call for Keith.

## Verification

- Red before: `ep12-micro-before.log` (bare `npm ci`, 0.744, 6 FAIL) and `ep12-micro-with-tf.log` (backend installed, 0.923, ofc-utility + path-boost FAIL).
- Green after: full micro-eval 13/13 with the backend installed (`ep12-micro-final.log`, 97.5s).
- Mutations, all run: (a) `node_modules/@huggingface` moved aside, the runner exits 1 before any fixture with `cosine 0, so no embedding was computed; the cross-encoder fell back to identity ordering` (`ep12-mutation-a.log`). Finding: without a backend hippo reports cosine 0, not null, so the guard is `cosine <= 0`, and the first draft's null check alone would not have fired. (b) HOME override replaced by `pass`, path-boost 1/2 FAIL (`ep12-mutation-b.log`), restored by string replace, never `git checkout`. (c) 12-sentence verbose memory: ratio 1.331 fails, recorded in `ep12-micro-with-tf.log` and `ep12-ofc-ratio.log`.
- `python -m py_compile benchmarks/micro/run.py`; a YAML parse of `.github/workflows/ci.yml`; the CI run on the PR shows the new job green.

## Reproduce

```
git -C <repo> log --format='%h %ad %s' --date=short -- benchmarks/micro/fixtures/ofc_utility.json | head -1
git -C <repo> show 4ce21e7 --stat | head -5
python benchmarks/micro/run.py --filter path-boost --verbose
```
