# Dated notes, 2026-11-17: MEME and TriggerBench as their own runners run a memory system

Post hoc and secondary, like lanes F and D (prereg Amendment 6, dated notes 30 and 31). No registered result changes.

**Why.** Keith (17 Nov): every public benchmark runs in its published setup, so hippo's row sits next to the published product rows on equal terms. MEME (arXiv 2605.12477) tests dependency reasoning over a changing memory: six tasks, three of them (Cascade, Absence, Deletion) new. TriggerBench (arXiv 2606.23459) tests prospective memory: a constraint said early must change the reply to a later trigger that does not ask for it. Both papers run Mem0 through one fixed answer and judge setup, so the rows differ only by the memory system.

## MEME

**Published rows (Table 2, accuracy, 100 episodes, 32K filler).** ER / Agg / Tr / Del / Cas / Abs / Overall. Mem0 (top 20) 0.67 / 0.35 / 0.43 / 0.21 / 0.03 / 0.00 / 0.28; Graphiti (top 10) 0.03 / 0.01 / 0.04 / 0.09 / 0.02 / 0.01 / 0.03. Raw retrieval (top 5 chunks of 4,096 tokens): BM25 1.00 / 0.05 / 0.16 / 0.27 / 0.02 / 0.00 / 0.25; text-embedding-3-small 0.96 / 0.33 / 0.46 / 0.17 / 0.04 / 0.00 / 0.33. File-based: MD-flat 0.94 / 0.45 / 0.77 / 0.25 / 0.05 / 0.05 / 0.42; Karpathy Wiki 0.11 / 0.18 / 0.27 / 0.03 / 0.01 / 0.02 / 0.10. In-context gpt-4.1-mini 1.00 / 0.27 / 0.69 / 0.45 / 0.03 / 0.04 / 0.41. Every memory system ran gpt-4.1-mini inside and as answerer.

**What changes.**
1. Code. `meme/meme_vendor.py` imports MEME's own code (MIT) from `SeokwonJung-Jay/MEME-public` at `cb8164d8` (clone in `~/hippo-bench/vendor/MEME`). `qa/vendor_pin.py` stops the lane unless the clone is at that commit and each of the 6 files used is the commit's blob. Used: `agents/base.py` (`UNIFIED_ANSWER_PROMPT`), `agents/mem0_memory.py` (`Mem0Memory.retrieve`, the context lines), `eval/judge.py` (`LLMJudge`, `judge_episode`), `eval/run_agent.py` and `scripts/run_main_experiment.sh` (the run order and models).
2. Data. `~/hippo-bench/datasets/meme/meme_filler32k.json` from Hugging Face `meme-benchmark/MEME` at revision `e14c4e68`; its SHA-256 must equal the LFS oid. 100 episodes, 494 before-questions, 694 after-questions (ER 100, Agg 100, Tr 100, Del 100, Cas 164, Abs 130).
3. Store. One hippo store per episode, as each Mem0 instance had its own collection. The sessions go in turn by turn, each turn dated with its session's timestamp. The before-questions retrieve after session `before_questions.position_after_session`, the after-questions after `after_questions.position_after_session`, as `run_episode` asks them. hippo's server stores each message as `<role>: <content>`. Arm `hippo-emb`, server flags of dated notes 5.
4. Retrieval. Top 20 per question, as the Mem0 row (`Memory.search` with no limit; the paper's appendix calls 20 the library default).
5. Context. The vendor's `Mem0Memory.retrieve` runs over hippo's hits: `[score=0.92] <memory>` lines in rank order, `(no relevant facts)` if none.
6. Answer. `UNIFIED_ANSWER_PROMPT` with the context and question, as one user message. `gpt-4.1-mini-2025-04-14`, temperature 0, `max_tokens` 500 (`base.py`; `tab:manifest` names the snapshot).
7. Judge. The vendor's `judge_episode` with `LLMJudge` on `gpt-4o-2024-08-06` (`tab:manifest`), temperature 0, `json_object`, one user message. Its OpenAI client is `LedgerClient`: each call is a ledger item asked through `qa/openai_llm.py`. ER is the vendor's substring check and makes no call; 988 answers get a judge call.
8. Score. Table 2's six task accuracies over the after-questions. Cas, Abs and Del count only a `real` pass (the before answer right too, the trivial-pass filter). Overall is the unweighted mean of the six.
9. Output: `results-r2/meme/<arm>/`; the smoke in `results-r2/meme/smoke/`.

**Deviations that stay.**
- Internal model. Mem0 got each session as 4,096-token chunks with a `[Session: <timestamp>]` header, and gpt-4.1-mini extracted facts from them. hippo runs no model at write time; it stores each message whole and keeps the session time as metadata, not in the text.
- Top k. The paper keeps each system's default (20 for Mem0, 10 for Graphiti, 5 chunks for raw retrieval). hippo stands in for the Mem0 wrapper, so 20.
- Absence labels. The README (v1.0, issue #2) lists 10 of the 130 Absence items whose gold should be the declared replacement. Table 2 scores them as released, and so do we.
- Retries. The ledger gives 3 asks per call; the first valid reply counts. A repeated judge prompt gets one ledger reply.
- Snapshots. Both shut down on 14 Jan 2027 (OpenAI deprecations page, read 17 Nov), so a full run must finish before then.

**Order.** For `hippo-emb`: `ingest`, `retrieve`, `answer`, `judge`, `score`; then `bm25`. A smoke runs first: episode pl_001's 5 questions (Del before and after, ER, Tr, Agg). It writes integrity counts and tokens only, never a score; `estimate` scales its tokens to the full run.
Smoke items, excluded: `pl_001-b3`, `pl_001-a4`, `pl_001-a6`, `pl_001-a0` and `pl_001-a5`. They are the `meme` key of `smoke_excluded.json` and stay out of the primary.

**Tests.** `tests/test_meme.py`. They fail if the clone or the data leave their pin, if the answer prompt's text changes, if the context lines leave the vendor's format, if the question counts change, if the answer or the judge leaves with another model, temperature, token cap or message shape, if a judge reply counts without a JSON object, or if Cas, Abs or Del count a trivial pass.

## TriggerBench

**Published rows (Table 3, `tab:main_results`, Base context, %).** Positive Clean slot / PM Acc, Positive Overloaded slot / PM Acc, Negative Clean PM Acc, All Positive slot / PM Acc, Overall PM Acc. "RAG & Memory Systems (GPT-4.1)": RAG 67.76 / 68.85, 30.91 / 27.87, 62.63, 49.34 / 48.36, 51.62; A-MEM 50.89 / 51.03, 27.56 / 22.95, 56.40, 39.23 / 36.99, 41.42; Mem0 70.32 / 71.31, 36.89 / 33.61, 55.71, 53.60 / 52.46, 53.20; Letta-Sim 79.44 / 75.20, 57.55 / 53.89, 54.67, 68.49 / 64.55, 62.29. GPT-4.1 with the full dialogue: 72.37 / 73.36, 38.29 / 36.68, 76.82, 55.33 / 55.02, 60.00. Letta-Sim is the authors' simplified Letta (appendix footnote), not the product. Mem0's Overall 53.20 is 673/1265 (348/488 + 164/488 + 161/289), the micro mean over every task.

**What changes.**
1. Code. `triggerbench/triggerbench_vendor.py` imports TriggerBench's own code (MIT) from `KristenZHANG/TriggerBench-Official` at `9e2185c3` (clone in `~/hippo-bench/vendor/TriggerBench`). `qa/vendor_pin.py` checks 5 code files and the 13 Base data files (CC BY 4.0). Used: `source/mem0_eval.py` (`_format_turn`, `_run_judge_batch`), `source/longcontext_blended_close.py` (`get_system_prompt`), `pm_judge.py` (`PMJudge`), `pm_scorer.py` (slot match), `source/run_mem0.sh` (top k, temperature, models). The vendor's Azure client is never imported; a stub stands in for it.
2. Data. The Base files only: 1,265 tasks (488 Positive Clean, 488 Positive Overloaded, 289 Negative Clean) over five dimensions. The 40K variant is out of scope.
3. Store. One hippo store per task with every turn before the trigger, each in `_format_turn`'s `USER [time]: text` form and dated with its turn time. Mem0 got the same per-turn messages: no Base turn reaches `MAX_TURN_TOKENS` (2,000), so `_run_one_mem0` never splits one. hippo stores each as `<role>: <content>`.
4. Retrieval. The formatted trigger retrieves the top 6 (`run_mem0.sh` `TOP_K=6`).
5. Answer. `_run_one_mem0`'s messages: the category's system prompt, then "Relevant memories ..." with `- <memory>` lines, the trigger and "Respond helpfully." `gpt-4.1` (the API returns `gpt-4.1-2025-04-14`), temperature 0.6, `max_tokens` 1,024.
6. Judge. The vendor's `_run_judge_batch` with `PMJudge` on `gpt-4o-2024-08-06`, temperature 0, `max_tokens` 256, its few-shot turns sent as separate messages (`Settings.shots`). Each few-shot set has its own ledger log. Logical-adherence negatives use the intent-only judge, as the vendor sets it.
7. Score. `tab:main_results`' columns: slot match and PM Acc per positive variant, PM Acc on Negative Clean, both over all positives, and Overall as PM Acc over all 1,265 tasks.
8. `qa/openai_llm.py`: `gpt-4.1` gets its list price ($2.00 / $8.00 per 1M) and `Settings` a `shots` field (fixed few-shot messages between system and user; their hash goes in `cli`).
9. Output: `results-r2/triggerbench/<arm>/`; the smoke in `results-r2/triggerbench/smoke/`.

**Deviations that stay.**
- Judge snapshot. `mem0_eval.py` calls an Azure deployment named `gpt-4o` and no source states its version. We use `gpt-4o-2024-08-06`, the OpenAI `gpt-4o` default.
- Answer snapshot. The Azure deployment `gpt-4.1` has one snapshot, `2025-04-14`, which is what our calls return.
- Retrospective probes. The paper's 440 RM probes are not in the release, and no memory system has an RM row, so the lane has no RM part.
- Internal model. Mem0 and A-MEM run GPT-4.1 inside to extract facts. hippo stores each message whole.
- Sampling. Answers at temperature 0.6 vary run to run. The paper made one per task, and so do we. A repeated judge prompt gets one ledger reply.
- Retrieval-rate tables (appendix, Positive Clean and Overloaded) use a word-overlap rule that is not in the pinned code; the lane does not rebuild them.
- Snapshots. Both shut down on 14 Jan 2027.

**Order.** As MEME. The smoke is the first task of five files: every dimension, both positive variants, both negative judge modes.
Smoke items, excluded: `tb-pc-seed_02`, `tb-po-seed_01_absolute_blind_action`, `tb-nc-logical_adherence_001`, `tb-pc-interrupt_seed_001` and `tb-nc-seed_b01`. They are the `triggerbench` key of `smoke_excluded.json` and stay out of the primary.

**Tests.** `tests/test_triggerbench.py`. They fail if the clone leaves its pin or the task counts change, if the vendor's `_run_one_mem0` (run with a fake Mem0 and client) sends other answer messages, query, top k or stored messages than the lane, if the answer or the judge leaves with another model, temperature, token cap or few-shot set, if a verdict counts without YES or NO, or if `table()` stops giving Mem0's published 71.31 / 33.61 / 55.71 / 52.46 / 53.20 from its counts.

**Read before this note.** MEME at `cb8164d8`: `README.md`, the six pinned files, `agents/_chunking.py`; the paper's Section 4, Table 2, `app:systems`, `tab:manifest`, arXiv source. TriggerBench at `9e2185c3`: `README.md`, the data README, the five pinned code files; the paper's `triggerbench-construction.tex`, `appendix-setup.tex`, `appendix-more-results.tex`, `appendix-data-analysis.tex`, arXiv source.
