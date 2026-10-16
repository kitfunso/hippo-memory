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

`C:/z0-runs/scored/pick.mjs` (sha256 `83a0bed66454ddfb5a2a713a8ffdf18072b8781f0b6a53734464219f424789e6`) applies the rule to `testgate.json` and `snapshot-gate.json` and writes `picks.json`. `node C:/z0-runs/scored/pick.mjs --order-only` prints the order; its first 10 are linguist, compose, quivr, zotero-format-metadata, DeepSeek-Reasonix, apollo, comprehensive-rust, ant-design-pro, aspnetcore and rustfs.
