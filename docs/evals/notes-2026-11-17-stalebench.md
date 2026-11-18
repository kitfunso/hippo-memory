# Dated notes, 2026-11-17: StaleBench Table 5, the systems track

Post hoc and secondary, like lanes F and D (prereg Amendment 6, dated notes 30 and 31). No registered result changes.

**Why.** StaleBench (arXiv 2611.19752, Findings of EACL 2027) streams real updating facts into a memory and asks a value-agnostic question per fact ("which team does X play for now?"). Table 5 places three deployed systems and a reimplemented fourth under the rungs' harness: Mem0 2.0.11 and 0.1.118, Graphiti as returned and with valid edges first, LangMem and ERASE, each with qwen2.5:14b and with glm-4.6. Keith (17 Nov): every public benchmark runs in its published setup, so hippo's row sits next to these on equal terms. The harness hands each system a statement's text and its time `t` in stream order, then asks for its own ranking.

**Published rows (Table 5, n = 150 test facts, p = 0.5).** Read from the arXiv PDF (`~/hippo-bench/comparability/papers/stalebench.txt`, lines 499 to 516). Each block is cur@1 by attribution, cur@1 by text, contamination@5 by text, and qwen2.5:14b answering from the top 5.

| Row | anchored | anchor-free |
|---|---|---|
| Mem0 2.0.11 | 0.180 0.480 0.947 0.627 | 0.120 0.153 0.820 0.580 |
| Mem0 0.1.118 | 0.913 0.573 0.593 0.720 | 0.653 0.207 0.747 0.500 |
| Graphiti, as returned | 0.347 0.347 0.947 0.593 | 0.180 0.180 0.820 0.433 |
| Graphiti, valid edges first | 0.833 0.833 0.120 0.893 | 0.640 0.640 0.153 0.773 |
| LangMem, qwen2.5:14b | 0.773 0.773 0.173 0.833 | 0.340 0.413 0.213 0.600 |
| LangMem, glm-4.6 | 0.800 0.147 0.753 0.613 | 0.627 0.160 0.640 0.413 |
| ERASE, qwen2.5:14b | 0.853 0.860 0.100 0.867 | 0.733 0.707 0.160 0.807 |
| ERASE, glm-4.6 | 0.953 0.953 0.060 0.980 | 0.713 0.713 0.240 0.813 |
| Cosine (store-all) | 0.460 0.460 0.973 0.573 | 0.140 0.140 0.927 0.427 |
| + time-rerank | 0.920 0.920 0.973 0.300 | 0.787 0.787 0.927 0.220 |
| Symmetric key | 1.000 1.000 0.007 1.000 | 0.920 0.920 0.027 0.920 |
| Overwrite: oracle | 0.987 0.987 0.007 1.000 | 0.887 0.887 0.000 0.953 |

The column mapping is checked, not read off the caption alone: the paper's own contexts file and its shipped reader cache, scored by the vendor's scorers over the rebuilt labels, give the Cosine, time-rerank, oracle and LangMem qwen2.5:14b cells of both blocks exactly (`tests/test_stalebench.py` pins the Cosine row).

**What changes.**
1. Code. `stalebench/stale_vendor.py` imports StaleBench's own code from `thenexuslab/stalebench-release` at `724fccc1` (v1.2.2, "sync with the camera-ready paper"; clone in `~/hippo-bench/vendor/stalebench-release`). `qa/vendor_pin.py` stops the lane unless the clone is at that commit and each of the 17 files used is its blob. Used: `metrics.score_ranking`, `metrics.score_texts`, `reader.build_prompt`, `reader.score_answer`, `reader.stale_values_of`, `systems.statement_time`, `templama.RELATIONS`, `llm.OllamaClient`, the anchored and anchor-free test files, `release/llm_cache.jsonl.gz`, and the paper's contexts sidecar `results/stalebench_systems_langmem_qwen.contexts.json`.
2. Data. Table 5 is `run_systems.py --limit 150`: `build_instance(test[:150], paraphrase_p=0.5, seed=0)` over TempLAMA. Raw TempLAMA is in neither the GitHub release nor the Zenodo archive (`stalebench-1.2.2.zip`, MD5 `038ca57c` as Zenodo lists it, no TempLAMA inside), so the stream is rebuilt from the release's test files: queries `q0` to `q149` are facts 0 to 149, their statements keep the release order, `t` is re-derived over the 150-fact stream as `build_instance` stamps it, and each run's value is read back from the anchored text through the relation's templates. 329 statements per config. Every gold value, every stale-value list and every ladder hit (id, text, year) in the paper's sidecar equals the rebuilt one.
3. Store. One hippo store per config, fed in stream order, one statement per memory. hippo's server stores it as `user: <statement>`. Each statement is dated `systems.statement_time(t)`, the date the paper's Graphiti wrapper gives each episode (Mem0, LangMem and ERASE take `t` in metadata and date by the wall clock). Arm `hippo-emb`, server flags of dated notes 5; its embedder is `all-MiniLM-L6-v2`, the encoder the paper fixes for every system.
4. Search. Each query is searched at depth 20, the `top_k` every wrapped system gets (`run_systems._DEPTH`). Each hit is attributed to the statement with its text and date, so cur@1 by attribution and by text use the same id the vendor scorers read.
5. Reader. `reader.build_prompt` over the top 5 statement texts (the `user: ` label dropped), asked of `qwen2.5:14b` through `OllamaClient`'s request: greedy, seed 0, 32 tokens (`run_reader._batch`). Two options are added: `num_gpu 0`, because another session's training run held 14.6 of 16 GB of VRAM, and `num_thread 4`, to keep CPU modest. Answers are cached by the client's own hash; the score stage reads the cache only.
6. Score. `score_ranking` and `score_texts` at k = 5, `score_answer` for the reader, means over the 150 queries per config.
7. Output: `results-r2/stalebench/<arm>/`; the smoke in `results-r2/stalebench/smoke/`.

**Deviations that stay.**
- Reader hardware. The paper's reader ran on unknown hardware; here it runs on CPU (Q4_K_M, ollama 0.40.16, tag id `7cdf5a0187d5`). The `reader-check` stage replays the paper's cosine top-5 prompts and counts answers equal to the cached ones; it has not run yet.
- Dates. hippo gets the Graphiti date, not the wall clock. `--undated` is the secondary that sends none.
- Role label. hippo's embedding covers `user: <statement>`, as in every hippo-emb lane.

**Order.** For `hippo-emb`: `ingest`, `retrieve`, `read`, `score`; then `reader-check`. A smoke runs first over the whole streams with five queries, and writes integrity counts only.
Smoke items, excluded: `anchored-q000`, `anchored-q075`, `anchored-q149`, `anchor_free-q000` and `anchor_free-q075`. They are spread over both configs.

**Tests.** `tests/test_stalebench.py`. They fail if the pin or the setup constants move, if the rebuilt stream stops matching the paper's sidecar, if the paper's cache stops giving Table 5's Cosine cells through these scorers, if the reader's request changes, or if a hit stops mapping to its statement.

**Read before this note.** At `724fccc1`: `README.md`, `release/README.md`, `stalebench/run_systems.py`, `run_sysreader.py`, `reader.py`, `metrics.py`, `llm.py`, `templama.py`, `systems.py` (Mem0 and Graphiti wrappers), `systems_langmem.py`, `release.py`. The paper's Section 5.4 and Table 5 (arXiv PDF, read 17 Nov).
