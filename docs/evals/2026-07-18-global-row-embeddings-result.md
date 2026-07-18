# 2026-07-18 Global-row embeddings (v1.27.0) - Result

**Status:** COMPLETE, all 4 pre-registered instruments PASS. Plan + pre-registration: `docs/plans/2026-07-18-global-row-embeddings.md` (episode 01KXV39T951THW81ZSD088FKZX).

## Defect

Rows written to the global store by `promoteToGlobal` / `shareMemory` (and local stores by `syncGlobalToLocal` / `hippo import`, including `--vault`) never entered the destination store's embedding index; hybrid recall scored them bm25-only. Discovered by score-verified precheck in the S5 episode (01KXTBPR, `2026-07-18-s5-path-overlap-result.md`), which measured ~5.4x hybrid-base deficit in a 3-competitor corpus.

## RED (pre-fix, v1.26.4 build; scratch HIPPO_HOME + scratch cwd; full precision)

- LOCAL twin base: `0.9074030329496725` (mode=hybrid, cosine 0.8456717215827875)
- PROMOTED g_ row base: `0.28768207245178085` (mode=bm25-only, cosine 0) - ratio 3.154186930093688x on this single-row corpus
- Global store `embeddings.json`: never created; promoted id absent.

## GREEN (post-fix, same probe method)

- LOCAL `0.9074030329496725` vs PROMOTED `0.9074030329496725` - **bit-identical** (ratio 1). Predicted by v1.26.0's `path:*` exclusion from embedding input text: identical content + tags -> identical vector.
- Global index contains the promoted id, 384-dim vector.

## Non-regression instruments

- **Micro-eval 12/12**; named watch `path_boost` (its fixture's promoted rows now gain vectors) 2/2, no ranking interaction.
- **Full suite**: 345 files passed / 3 skipped, 2752 tests passed / 4 skipped; +1 file / +9 tests vs the 1.26.4 baseline = exactly the new `tests/global-row-embeddings.test.ts`.
- **LoCoMo smoke**: grep proves `benchmarks/locomo` never calls promote/share/autoShare (ingest = init/remember/recall), so the diff is structurally outside that path; two fresh-store conv-26 sample-10 runs byte-identical (0/10 mismatches). Caveat recorded honestly: no live 1.26.4 binary head-to-head; the verdict rests on the code-identity argument plus the determinism reconfirmation.

## Known limitation

vitest's VM execution breaks `embeddings.ts`'s `_dynImport` (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`, pre-existing and environment-wide), so in-process positive-embedding tests skip; real-path coverage rides on two real-`node` subprocess tests (producer wiring for `promote`, and `hippo embed --global` from a cwd with no local store). `embeddingIsFunctional()` in the test file swallows only that specific error and rethrows anything else.

Raw probe transcripts + instrument outputs: episode trajectory dir (gitignored) `trajectories/01KXV39T951THW81ZSD088FKZX/`; every probe command is recorded in the transcripts and re-runnable against scratch stores.
