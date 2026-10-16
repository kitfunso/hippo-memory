# Z0 scored task set record (stage 3), started 2026-10-16

Stage 3 of the prereg (`2026-09-29-z0-built-in-memory-prereg.md`, stage 3): the scored task set, authored after the freeze by blind authors and screened on the control arms. The design is `docs/evals/z0-freeze/sizes-a2x-e0.15-r10.json`: 10 repositories, each with 3 set R families, 3 set X families and 6 set N tasks. The task files stay outside this repository until the result is published; this record holds the rules, the repositories with their pins, the hash, the drop list and the overlap table.

## Pick rule, set before any test result was read

Set on 2026-10-16. A test worker started timing the candidates' test commands before this rule was written, but no result of it had been read when this section was committed.

- **Input.** `C:/z0-runs/scored-shortlist/candidates.json`, sha256 `5e4d0d228db19fedeabc3f958d804118ec2aa9809c822df354211c185b6aaa75`: 48 public repositories with their default-branch commit (the pin), language, licence, rule files, test command, and the rule lines a heuristic found checkable. The shortlist script (`build.py`) excludes the development repositories.
- **Eligible.** An OSI licence, at least 4 checkable rule lines, and a product that is not agent instruction files (this drops `Yeachan-Heo/oh-my-claudecode`).
- **Order.** Each eligible repository's sort key is the sha256 of `<candidates sha256>:<owner/name>`, ascending. No count of rule lines enters it. The shortlist heuristic counts modal words such as "never" and "always", and hippo's capture reads the same words, so ranking by that count could favour hippo.
- **Walk.** In that order, take a repository if it passes the test gate and its language is under the cap. Stop at 13: the first 10 are scored and 11 to 13 are spares, in order. The walk runs in tiers. The first tier needs 6 or more rule lines with a cap of 2 per language. If 13 are not found, the second tier raises the cap to 3. The third tier lowers the rule floor to 4. Each tier walks the same order and skips the repositories already decided.
- **Test gate.** The candidate's test command runs at the pin on this machine, once to warm the caches and once timed. It passes if the timed run takes 300 seconds or less and either exits 0, or has 20 or more passes with at most 2% failures. Both an upstream clone and a clone of the eval snapshot must pass; the snapshot's time is recorded. A command that cannot run as written on Windows gets the smallest faithful translation, made by the test worker, who never saw this rule; `testgate.json` records each translation.
- **Fewer than 10.** If the tiers end with fewer than 10 repositories, stage 3 stops and reports, since the go fixed 10.

`C:/z0-runs/scored/pick.mjs` (sha256 `5bc99b6cfd18d8fbb1893e0390fbb15d0078e06eb7f99e2d0b1b32a532ee060e`; the first version, `83a0bed6`, read the gate files as arrays and crashed on their keyed-object form before any pick, and only that reader changed) applies the rule to `testgate.json` and `snapshot-gate.json` and writes `picks.json`. `node C:/z0-runs/scored/pick.mjs --order-only` prints the order; its first 10 are linguist, compose, quivr, zotero-format-metadata, DeepSeek-Reasonix, apollo, comprehensive-rust, ant-design-pro, aspnetcore and rustfs.

## Split rule, set before any family was authored or screened

Set on 2026-10-16. The split uses family numbers only, never how strongly a family screened.

- **Numbers.** Each repository's families are numbered in authoring order, `<key>-f1` upward. An inventory session first lists the repository's usable rules. Family sessions then write up to 4 families each, 12 at most. A top-up session continues the numbering.
- **Screen in waves.** Families 1 to 8 are screened first, under the keep rule of prereg line 68. Families 9 to 12 are screened only for a repository with no admissible split after wave 1. A void screen session counts as missing. If a family's recorded sessions already fix its verdict, the verdict stands, as for hp-f4 in the stage 2 record; otherwise the family is screened again.
- **Set N.** Merged against every kept family of the repository. Set R's sequence takes the first 6 in merge order.
- **Pools.** A pool is 6 kept families. Pools are tried in lexicographic order of their sorted family numbers, so the first is the 6 lowest-numbered kept families.
- **Splits.** Within a pool, 3 families go to set X and 3 to set R. Splits are tried in lexicographic order of set X's sorted numbers. The first admissible split is taken.
- **Admissible.** Reversal families in set X and set R differ by at most 1. Each set holds at most 1 template family, so across the 10 repositories each set is at least two thirds maintainer rules (prereg line 51). Set X's lesson tasks draw an order on seeds 1 to 9 as sequence `<key>-x`. Set R's lesson tasks plus its 6 set N tasks draw an order on seeds 1 to 9 as sequence `<key>`. These are the sequence ids the scored spec uses.
- **No admissible split.** Wave 2 is screened. If there is still none, or fewer than 6 families are kept, a top-up session writes up to 4 more families from unused inventory rules; they are screened and the rule runs again. If the repository still has no admissible split, the next spare replaces it.

`C:/z0-runs/scored/split.mjs` (sha256 `9c4da180d4cfca570475084d509fc0ba9c8206818ca24371b4f12d8bd74c8160`) applies the rule to one repository's merged spec and kept list. It draws orders with the runner commit's `drawOrder` (`45b57c6b`, `scripts/token-eval/lessons.mjs`).

## Authoring

Authors run `scripts/token-eval/z0-author.mjs` from the runner commit (`45b57c6b`) on the subscription, with model `claude-opus-5-5`. Each author's checkout is built in place by `buildSnapshot` from the pinned source, so its git config and reflog name no outside path, and it must equal the gated snapshot commit.

- **Inventory.** One session per repository judges every rule line against criteria 1 to 6 and writes the kept list in its own order, the real rule changes found in `rules/history/`, and the template fits. Brief: `C:/eval-authors/s3x-inventory-template.md` (sha256 `8a6acd24bb55cb3ab2b2d252a7221b6228461a7c4828d85d84d9ebcce520ebfa`).
- **Family sessions.** Session `s` takes kept rules `4(s-1)` to `4s - 1` and the `s`-th fitting template, and numbers its families from `4s - 3`. Sessions 1 and 2 run in parallel. A rule is skipped as a duplicate when a lower-numbered kept rule asks for the same thing; the templates of sessions 1 and 2 count as number 0. Brief: `C:/eval-authors/s3x-family-template.md` (sha256 `0a73c64c9f9e9675684821ffdd818c9ffe50f3fa4ede51c0f0ce5397d234d47f`), filled by `C:/eval-authors/s3x-fill.mjs` (sha256 `0cb19834f45c0bed5be445909b6902cf2244e6f6a661d80b626d76da2801b279`) from `C:/eval-authors/s3x-repos.json`.
- **Snapshot half of the test gate.** `C:/z0-runs/scored/snapshot-gate.mjs` (sha256 `61b557d80c503d7409063d6ce4dd2cca1430e158832e37d05a08c6f0c3cc4b05`) builds each snapshot from a blobless clone and reruns the upstream install and test commands on it. A snapshot whose tests fail only where upstream fails (same failing tests) gets the upstream pass and fail counts.
