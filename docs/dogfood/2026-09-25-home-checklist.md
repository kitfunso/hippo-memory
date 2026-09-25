# Things to run at home (from the 2026-09-25 session)

The work box shipped 1.47.0: TE11 on the roadmap, and CD13, the failure log behind `hippo failures`. It is on npm with provenance and has a GitHub release. What is left needs your machine: the work box has no hippo install, the home session's branch exists only at home, and home is the source of truth for claude-config.

## 1. Before the home session merges anything
- [ ] Rebase onto master, which moved to 1.47.0 while the home session was stopped (#237 TE11, #238 CD13, #239 the release).
- [ ] CD13 took schema v46 (`failure_log` in `src/db.ts`), so a migration on the home branch becomes v47. These 17 test files assert the schema version and move with it: `git grep -lE "SchemaVersion\(.*\)\)\.toBe\(46\)|schema_version'\)\)\.toBe\('46'\)" -- tests`.
- [ ] Bump the next release past 1.47.0.

## 2. Check the failure log on your machine
- [ ] Update to 1.47.0 (`npm install -g hippo-memory@1.47.0`) and run `hippo doctor`. The failures row should read "N failed tool calls logged in 7 days". A warning that the `failure_log` table is missing means failures are not being logged.
- [ ] After a day of normal sessions, run `hippo failures`. Check that the outcome counts look right and that the repeats across sessions are real repeats. The log keeps two hashes per failure, never the error text.

## 3. Write-path cost (ROADMAP 90-day queue, weeks 0-4)
- [ ] Before starting, read `docs/evals/2026-09-25-write-path-cost.md`: per-step timings at 2,000 and 10,000 memories, six findings and the probe scripts. The biggest is the `index.json` rebuild, about 34 of the 40 ms a write grows by. 1.45.0's notes promised to stop that rebuild in 1.46.0 (`CHANGELOG.md:145`, `README.md:259`), and it still runs.
- [ ] After the fix, re-time `tests/server-outcome-route.test.ts` "1000 ids at boundary". It fails near its 30 s budget in full local runs (TODOS.md, "CD13 follow-ups").

## 4. claude-config (optional)
- [ ] The global `publish-repo` skill says to run `npm publish` from your machine and never to use `npm version`. `docs/release-policy.md` here says the opposite on both. Add a line to the skill: a repository's own release policy wins over its steps.

## 5. First `stable` promotion, and SECURITY.md (from the 1.48.0 work)
- [ ] From 2 Oct 2026, promote the newest release that has been `latest` for 7 days with no fix release on top of it: 1.48.0 if nothing has shipped since. Run `npm dist-tag add hippo-memory@<x.y.z> stable` (it needs your npm login), then record the promotion in that release's entry in `CHANGELOG.md`. No release has been promoted before. This one starts its line's 12 months of support and uses the October-December quarter's one promotion (`docs/release-policy.md`, "Support window").
- [ ] `SECURITY.md` changed on the work box: the supported-versions table (the support window), the provenance line (from 1.47.0, not 1.46.0), a line naming the SBOM on each GitHub release, and a bullet pointing reporters at `hippo support-bundle`. The weeks 0-4 "Company basics" pass should build on this version, not replace it.
