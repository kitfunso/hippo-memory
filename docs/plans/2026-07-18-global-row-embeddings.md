# Plan: embed promoted/shared global-store rows (v1.27.0) — Revision 1

Status: Draft r2 (episode 01KXV39T951THW81ZSD088FKZX; r1 plan-eng FAIL 61, all 5 must-fix addressed below)

## Problem

Rows written to the global store by promote/share/import paths never enter the destination store's embedding index, so they score bm25-only in hybrid recall: measured ~5.4x hybrid-base deficit vs an identical local twin (episode 01KXTBPR, `docs/evals/2026-07-18-s5-path-overlap-result.md`; ~0.165 vs ~0.898). Mirrored defect: `syncGlobalToLocal` writes global rows into local stores unembedded.

## Root cause + COMPLETE producer table (r1 must-fix 1)

The invariant that broke: a row entering a store must enter that store's embedding index under the same best-effort contract as `remember`. All FIVE writeEntry sites that can target the global root, audited:

| Site | Embeds today? | Action |
|---|---|---|
| `shared.ts:86` promoteToGlobal | NO | FIX: `void embedMemory(globalRoot, globalEntry).catch(()=>{})` after writeEntry (single-row producer) |
| `shared.ts:402` shareMemory | NO | FIX: same one-liner, unless new optional `opts.skipEmbed` is set (single-row producer; skipEmbed is for autoShare batching only, additive param) |
| `cli.ts:798` remember --global | YES (:809) | none (already correct) |
| `capture.ts:594` capture --global | YES (:599) | none (already correct) |
| `importers.ts:143` import (targetRoot may be global) | NO | FIX in `cmdImport`: after a non-dry-run import that wrote >=1 row, one `void embedAll(targetRoot).catch(()=>{})` (batch producer) |

`api.ts:2458` recall-refresh rewrites existing global rows with unchanged content — vector stays valid, no change.

**Batching invariant (r1 must-fix 4):** single-row producers use `embedMemory`; batch producers use ONE `embedAll` on the destination after their loop. So `autoShare` passes `{skipEmbed: true}` to shareMemory and runs one `void embedAll(globalRoot).catch(()=>{})` when it shared >=1 row — avoiding N serialized full-index rewrites per sleep batch (each embedMemory rewrites the whole multi-MB index JSON). `syncGlobalToLocal` likewise: one `void embedAll(localRoot).catch(()=>{})` when count > 0.

**embedAll characterization (r1 med):** embedAll backfills ALL unembedded rows in the destination store (not only the just-copied ones — accepted as healing) and, if the index identity changed, full-rebuilds the index + resets physics. Perf note documented in code comment + CHANGELOG.

## Design decision: compute-on-destination, not vector-copy

`embedMemory`/`embedAll` own the full per-store contract (provider resolution, availability gate, identity check + reindex, index write, storedModel stamp, physics init — embeddings.ts:432-560); a copied vector is silently wrong whenever the destination identity differs (pluggable providers, PR #100). **Acknowledged asymmetry (r1 med):** when the destination provider is unavailable but the source vector exists, compute leaves the row unembedded until healed, where copy would have filled it — accepted: per-store correctness + the healing paths dominate, and the config split (local embeddable, global not) is an edge state.

## hippo embed --global (r1 must-fix 2)

`cmdEmbed` currently opens with `requireInit(hippoRoot)` (cli.ts:5715). The flag must mirror `resolveAuthRoot` (cli.ts:6900): when `--global` is set, `initGlobal()` + use `getGlobalRoot()` and SKIP the local requireInit; the resolved root is threaded through EVERY hippoRoot reference inside cmdEmbed (requireInit, resolveEmbeddingProvider :5753, loadConfig :5764, embedAll call :5784, partial-progress loadEmbeddingIndex :5787, and any physics/status refs). This is the documented healing path for pre-1.27.0 global stores and MUST work from a directory with no initialized local store. Sleep-integrated auto-backfill stays DEFERRED (hook-latency risk; follow-up filed).

## Versioning

1.27.0 (new CLI surface = minor). 5 lockstep manifests (`package.json`, `openclaw.plugin.json`, `extensions/openclaw-plugin/package.json` + its `openclaw.plugin.json`, `src/version.ts`); `check-manifest-versions.mjs` enforces. CHANGELOG upgrade note: run `hippo embed --global` once to heal existing global stores.

## Fail-soft windows (audit rule 12)

Embeds run AFTER committed writeEntry. (a) process exit before unawaited embed settles → healed by `hippo embed --global` / next batch embedAll; (b) provider failure → `.catch` no-op, same healing; (c) no second-DB-connection hazard: index is a JSON file behind withEmbedLock; physics init opens its own connection after writeEntry's transaction closed (identical to remember path today).

## Tests (real stores; conventions per tests/embeddings.test.ts; r1 must-fix 5)

- **Deterministic unavailable-provider test:** force `embeddings.enabled=false` in the scratch store config (NOT reliance on model absence); promote/share succeed, return entries, write NO index entry, never throw.
- **Awaited wiring tests:** call the producers, then `await embedMemory(...)`-equivalent seam? No — test the observable contract instead: with embeddings enabled and available, `await vi.waitFor(() => loadEmbeddingIndex(globalRoot)[gId])` with generous timeout (>=30s first-run model load), gated on `isEmbeddingAvailable()`. Plus one direct `await embedAll(destRoot)` test per batch producer asserting the copied ids gain vectors (await removes the poll entirely for batch paths).
- **embed --global CLI test:** from a cwd with NO local store: seed a global row without vector, run `hippo embed --global`, assert exit 0 + index entry (gated on availability). Also asserts no requireInit failure — the r1 catch.
- **Existing suites green:** shared, secret-detect (veto ordering unchanged — embed fires only post-veto), v039 tenant isolation.

## Acceptance (pre-registered; r1 must-fix 3 resolved)

1. **S5-style probe** (scratch HIPPO_HOME + scratch cwd; full-precision pairs): promoted row's hybrid base within noise of its local twin. RED captured on master pre-fix (`trajectories/.../red-probe-globalembed.txt`); GREEN after.
2. **LoCoMo smoke byte-identical vs 1.26.4** — the smoke harness ingests into per-conversation local stores and never promotes/shares (VERIFY this claim at execute entry with a grep of the harness ingest path; if promoted/shared rows DO exist in the corpus, STOP and re-scope this criterion before executing). Byte-identical is therefore expected; the cross-store dedup interplay is NOT pinned by LoCoMo — it is pinned by the S5-style probe (green run exercises promote + cross-store recall + content dedup) and the micro path_boost fixture.
3. **Micro-eval 12/12** — with a NAMED WATCH: the path_boost fixture's promoted rows now legitimately gain vectors, so its rankings could shift. Pre-analysis: its assertions are nonce-term top-1 memberships where embedding similarity aligns with bm25; expected green. If it goes red, that is a REAL ranking interaction: stop, analyze, escalate to review — never silently re-baseline the fixture.
4. **Full suite green.**

## Out of scope

Sleep-integrated global backfill (follow-up); per-tenant embedding indices; localBump/equal-sources rebalancing; api.ts:2458 refresh path (update-only, vector remains valid).
