# Dated notes, 2026-11-17: LoCoMo-Plus through its released evaluation framework

Post hoc and secondary, like lanes F and D (prereg Amendment 6, dated notes 30 and 31). No registered result changes.

**Why.** LoCoMo-Plus (arXiv 2602.10715) adds 401 cognitive-memory samples to LoCoMo: a cue early in a conversation and a later trigger whose right answer depends on the cue. Table 1 holds three memory products on GPT-4o: Mem0, SeCom and A-Mem. Keith (17 Nov): every public benchmark runs in its published setup, so hippo's row sits next to these on equal terms. The repo releases the data builder and the evaluation framework (answer and judge), but no memory-system code.

**Published rows (Table 1, "Memory Systems (GPT-4o)").**

| Row | single-hop | multi-hop | temporal | common-sense | adversarial | LoCoMo | LoCoMo-Plus | Gap |
|---|---|---|---|---|---|---|---|---|
| Mem0 | 80.20 | 48.10 | 39.40 | 66.20 | 30.50 | 57.24 | 15.80 | 41.44 |
| SeCom | 77.60 | 50.90 | 42.30 | 71.40 | 31.80 | 57.53 | 14.90 | 42.63 |
| A-Mem | 76.90 | 55.60 | 49.30 | 68.10 | 35.20 | 59.64 | 17.20 | 42.44 |

LoCoMo is the item-weighted mean of the five categories (841, 282, 321, 96 and 446 questions): it rebuilds 57.21, 57.52 and 59.62 from the printed cells, within their rounding. Gap is LoCoMo minus LoCoMo-Plus.

**What changes.**
1. Code. `locomo_plus/locomo_plus_hippo.py` imports the framework from `xjtuleeyf/Locomo-Plus` at `059f4e3d` (clone in `~/hippo-bench/vendor/Locomo-Plus`). The repo has no licence file, so none of it is copied. `qa/vendor_pin.py` stops the lane unless the clone is at that commit and each of the 10 files used is the commit's blob (`git hash-object --no-filters`): `data/build_conv.py`, `data/unified_input.py`, both data JSONs, `task_eval/utils.py`, `prompt.py`, `llm_as_judge.py`, `evaluate_qa.py`, `evaluate.sh` and `judge.sh`.
2. Data. `build_unified_samples` gives 2,387 samples: single-hop 841, adversarial 446, Cognitive 401, temporal 321, multi-hop 282 and common-sense 96.
3. Store. One hippo store per dialogue: the 10 LoCoMo conversations, and one per Cognitive sample, rebuilt with `build_conv`'s own `build_context` and checked turn for turn against its dialogue. That is 411 stores and 242,339 turns. Each turn is one memory in the framework's line format (`Speaker said, "text"`, plus `and shared <caption>.` in LoCoMo), at its session time. A Cognitive store holds every turn but the trigger, which is the query. Arm `hippo-emb`, server flags of dated notes 5.
4. Retrieval. Top 5, the paper's RAG rows' "top-5 most relevant dialogue segments". The paper gives no top k for the memory products.
5. Answer. The framework's input with hippo's hits, oldest first, in place of the whole dialogue: LoCoMo as `DATE:` and `CONVERSATION:` blocks and then the question; Cognitive as bare lines and then the trigger line. `_build_model_input` adds the conversation prefix and the task instruction. `gpt-4o-2024-08-06`, temperature 0.3 (`evaluate.sh`), `max_tokens` 1024 (`evaluate_qa.py`).
6. Judge. `llm_as_judge.py`'s category prompts with the conversation prefix it adds, as it calls `call_model` with no category. `gpt-4o-2024-08-06`, temperature 0, `max_tokens` 512. Its parser maps `correct` to 1, `partial` to 0.5 and anything else to 0.
7. Score. Table 1's cells: the mean score per category, LoCoMo over the 1,986 LoCoMo items, LoCoMo-Plus over the 401 Cognitive items, and the gap.
8. Output: `results-r2/locomo-plus/<arm>/`; the smoke in `results-r2/locomo-plus/smoke/<arm>/`.

**Deviations that stay.**
- Judge. Table 1 does not name its judge. Table 2 measures human agreement with gemini-2.5-flash, and Table 3 compares Gemini-2.5-Flash with GPT-4o on the same answers: the two differ by 0.68 to 3.33 points. `judge.sh` defaults to gpt-4o-mini. We judge with GPT-4o, one of the paper's two judges, because the Gemini key has no credit. The ledger keeps every answer, so a gemini-2.5-flash re-judge needs no new answer.
- Memory products' setup. The paper gives no top k, answer prompt or internal model for Mem0, SeCom or A-Mem, and the repo has no code for them. Hippo's row is "hippo's top 5 under the framework's own answer prompt and judge".
- Snapshot. "GPT-4o" is pinned to `gpt-4o-2024-08-06`. OpenAI shuts it down on 14 Jan 2027 (deprecations page, read 17 Nov).
- Sampling. Answers run at temperature 0.3, so they vary run to run. One answer per sample, as the framework makes.
- Failed calls. Each item takes the first valid reply in 3 asks (`qa/ledger.py`); an answer with none scores 0 and is listed.

**Order.** For `hippo-emb`: `ingest`, `retrieve`, `answer`, `judge`, `score`; then `bm25`. Five samples run first as a smoke: LoCoMo samples 0, 496, 992 and 1488, and the first Cognitive sample. The smoke writes integrity counts and tokens only, never a score. Its samples are the `locomo-plus` key of `smoke_excluded.json` and stay out of the primary.
Smoke items, excluded: `lp-0000`, `lp-0496`, `lp-0992`, `lp-1488` and `lp-1986`. They are four LoCoMo questions spread over the 1,986 and the first Cognitive sample.

**Tests.** `tests/test_locomo_plus.py`. They fail if the clone leaves its pin, if the sample, store or smoke counts change, if the answer or judge leaves with another model, temperature, token limit or message shape, if the answer input or the judge prompt fills differently from the framework, or if the Table 1 cells stop averaging items.

**Smoke (17 Nov).** `hippo-emb`, the 5 smoke samples. Ingest stored every turn of the 5 stores (419, 663, 680, 681 and 421), retrieval wrote the manifest, all 5 judge labels parsed, and no answer was exhausted. Every reply came from `gpt-4o-2024-08-06`. Answers: 5 calls, 1,809 tokens in and 244 out. Judge: 5 calls, 1,174 in and 251 out. That is about 700 tokens per sample, all in the free big pool. Ingest took about 5 minutes for the 2,864 turns on one shard.

**Calls.** One arm, scaled from the smoke: 1.42M tokens in and 0.24M out, all in the big pool (250,000 a day), so about 6.6 free days. At list price ($2.50 and $10.00 per million) that is about $5.92. If every answer and judge reply ran to its cap, the output would be 3.67M, about 20 free days or $40. Ingest of 242,339 turns takes about 7 hours on one shard. No paid call: the free-token cap of dated notes 30 holds every call.

**Read before this note.** At `059f4e3d`: `README.md`, `data/build_conv.py`, `data/unified_input.py`, `task_eval/utils.py`, `prompt.py`, `evaluate_qa.py`, `llm_as_judge.py`, `evaluate.sh` and `judge.sh`. The paper's section 6, Tables 1 to 3 and Appendix B (arXiv HTML).
