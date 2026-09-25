# Things to run at home (from the 2026-09-25 session)

The work box merged and tagged 1.47.0: TE11 on the roadmap, and CD13, the failure log behind `hippo failures`. What is left needs you or your machine: the work box has no npm login and no hippo install, the home session's branch exists only at home, and home is the source of truth for claude-config.

## 0. Finish the 1.47.0 publish, if it is still open
`npm view hippo-memory@1.47.0 version` prints `1.47.0` once it is out; if it does, skip this section.
- [ ] npmjs.com, hippo-memory, Settings, Trusted publishing: check the entry is on the hippo-memory package, reads `kitfunso` / `hippo-memory` / `npm-publish.yml` with no environment, and has "Allow npm publish" ticked. The entry went in on 2026-09-25, and a rerun of publish run 36152076228 minutes later still got E404, the same refusal as before the entry existed.
- [ ] Rerun the publish: `gh run rerun 36152076228 --repo kitfunso/hippo-memory`. Never publish from your machine; a local publish has no provenance (`docs/release-policy.md`).
- [ ] Create the GitHub release for `v1.47.0`, with the 1.47.0 section of `CHANGELOG.md` as its notes.

## 1. Before the home session merges anything
- [ ] Rebase onto master, which moved to 1.47.0 while the home session was stopped (#237 TE11, #238 CD13, #239 the release).
- [ ] CD13 took schema v46 (`failure_log` in `src/db.ts`), so a migration on the home branch becomes v47. These 17 test files assert the schema version and move with it: `git grep -lE "SchemaVersion\(.*\)\)\.toBe\(46\)|schema_version'\)\)\.toBe\('46'\)" -- tests`.
- [ ] Bump the next release past 1.47.0.

## 2. Check the failure log on your machine
- [ ] Once 1.47.0 is on npm, update to it (`npm install -g hippo-memory@1.47.0`) and run `hippo doctor`. The failures row should read "N failed tool calls logged in 7 days". A warning that the `failure_log` table is missing means failures are not being logged.
- [ ] After a day of normal sessions, run `hippo failures`. Check that the outcome counts look right and that the repeats across sessions are real repeats. The log keeps two hashes per failure, never the error text.

## 3. Write-path cost (ROADMAP 90-day queue, weeks 0-4)
- [ ] Before starting, read `docs/evals/2026-09-25-write-path-cost.md`: per-step timings at 2,000 and 10,000 memories, six findings and the probe scripts. The biggest is the `index.json` rebuild, about 34 of the 40 ms a write grows by. 1.45.0's notes promised to stop that rebuild in 1.46.0 (`CHANGELOG.md:145`, `README.md:259`), and it still runs.
- [ ] After the fix, re-time `tests/server-outcome-route.test.ts` "1000 ids at boundary". It fails near its 30 s budget in full local runs (TODOS.md, "CD13 follow-ups").

## 4. claude-config (optional)
- [ ] The global `publish-repo` skill says to run `npm publish` from your machine and never to use `npm version`. `docs/release-policy.md` here says the opposite on both. Add a line to the skill: a repository's own release policy wins over its steps.
