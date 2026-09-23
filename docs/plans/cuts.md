# Cuts

Work taken off the active list, one line of reason each. `ROADMAP.md`
("Cut criteria") logs its cuts here.

## 2026-09-23: architecture review follow-ups (PR #222)

### Deferred to 1.46.0

- **Export the `api.ts` facade from `src/index.ts` (M10).** The CLI still calls store functions directly; route it through `api.ts` first so the export has one entry path. 1.45.0 only corrects the CHANGELOG line that told callers to import `recall()` from `index.ts`.
- **The 47 bare catches (L1).** Each needs a read of its own call site, and routing the CLI through the facade rewrites most of them.
- **Share the request code of `python/src/hippo_memory/client.py` and `sync_client.py`.** Each file carries the same 117 `/v1` lines; that duplication is the real cost.
- **A Windows CI job (M14).** On `windows-latest`, 20 tests in 8 store-heavy files still timed out with the test stores on D: and Defender's real-time scan off: vitest took 900 s, against about 2 minutes on Linux. Stores already run WAL with `synchronous = NORMAL`, so commit syncs are not the cost. The job returns once the slow step is measured.

### Cut

- **Align `ui/` on the root vitest (M16).** `ui/` is its own package, and a root vitest 4 bump would change the output `scripts/check-tests-pass.mjs` parses.
- **Rename the OpenClaw plugin package (M16).** The package name equals the manifest id `hippo-memory` and the install folder `~/.openclaw/extensions/hippo-memory`; a rename breaks existing installs for no gain.
- **A Python `/v1` base-path constant (M16).** Speculative until a `/v2` exists.
- **Collapse the seven 90-day half-life constants (L1).** Each kind module imports its own constant, so a decay change can move one kind without touching the others.
- **Drop `peerDependenciesMeta` (L3).** It is not empty: it marks both transformers packages as optional peers, and Yarn adds a `*` peer for any name listed only there.
- **Drop the `protobufjs` override (L3).** The base tree has no protobufjs, but the micro-eval job installs `@huggingface/transformers@4.2.0`, whose `onnxruntime-web` pulls protobufjs ^7.2.4; the override pins that tree.

### Kept as they are (M14)

- **Eval tests stay in the unit suite.** The slowest eval test file runs in 2.9 s; the slow files are integration tests.
- **The changelog-fragment check stays publish-time only.** It fails while any fragment is unreleased, which is true of every open PR.
