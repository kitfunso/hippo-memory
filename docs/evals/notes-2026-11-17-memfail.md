# Dated notes, 2026-11-17: MemFail as its task scripts run a memory system

Post hoc and secondary, like lanes F and D (prereg Amendment 6, dated notes 30 and 31). No registered result changes.

**Why.** MemFail (arXiv 2605.26667 v1, 26 May 2026) runs memory systems through five tasks and sorts each failure into storage, summary, retrieval and reasoning errors. Figure 1 plots four products with GPT-4.1-mini as their internal model: Mem0, SimpleMem, A-MEM and StructMem. The paper fixes gpt-5-mini "as both test-taker and grader", so the rows differ only by the memory system. Keith (17 Nov): every public benchmark runs in its published setup, so hippo's row sits next to these on equal terms. The paper's plug-in point is three functions (store a finished conversation, return the top k, return every stored memory for the judge); "any system implementing these three functions automatically plugs into our evaluation harness". This lane gives hippo those three.

**Published rows (Figure 1, k = 5).** The paper prints these points only in Figure 1, a vector SVG (`gpt-4.1-mini.svg` in the arXiv v1 source, SHA-256 `36c856507f17a158`). `decode_fig.py` reads the plotted vertices from the SVG paths; nothing is read by eye. Each rate times its n lands within 0.0074 of a whole number (all 136 points), so the counts are exact; in the first three panels every error bar also equals the count's 95% Wilson interval. Correct of n:

| Row | Coexisting | Conditional | Conditional-Hard | Persona, non-misleading | Persona, misleading | Long-Hop |
|---|---|---|---|---|---|---|
| Mem0 | 35/100 | 58/100 | 13/100 | 14/143 | 137/157 | 13/92 |
| SimpleMem | 7/100 | 85/100 | 27/100 | 108/143 | 149/157 | 21/92 |
| A-MEM | 25/100 | 95/100 | 35/100 | 125/143 | 138/157 | 14/92 |
| StructMem | 25/100 | 88/100 | 31/100 | 108/143 | 156/157 | 23/92 |

The n values are the questions each task script builds at seed 42: 100, 100, 100, 300 for persona (143 base, 157 misleading, 52.3% as Table 2 says) and 92. The decoder, its count step and the SVG are in `~/hippo-bench/comparability/scripts/memfail-fig1/`.

**What changes.**
1. Code. `memfail/vendor.py` imports MemFail's own code from `ishirgarg/MemFail` at `61ab3028` (clone in `~/hippo-bench/vendor/MemFail`). The repo has no licence file, so none of it is copied. `qa/vendor_pin.py` stops the lane unless the clone is at that commit and each of the 22 files used is the commit's blob, hashed with `git hash-object --no-filters` so a CRLF checkout fails. Used: `src/` (dataset, chat, prompt templates, LLM, evaluation), each task's `evaluate_*.py` (`load_dataset`, `build_chat_dataset`) and `analyze_errors.py` (the judges), and the five dataset CSVs. The evaluate scripts import product wrappers from `playground/utils.py`, which commit `bc2dd1b` removed. A stub stands in for that module, and none of its functions run.
2. Data. Each task is built at seed 42 as its shell script calls it: one fact per group, coexisting facts in separate chats, long-hop at hop counts 1, 2 and 3 with no limit. Storage facts and questions: coexisting 340 and 100, conditional 100 and 100, conditional-hard 100 and 100, persona 100 and 300, long-hop 274 and 92.
3. Storage turns. Each storage conversation runs in turn order as `Evaluator.evaluate_conversation` runs it. An ungraded turn retrieves nothing (`src/evaluation.py` 184 to 187); its prompt is the ungraded `ConversationHistoryPromptTemplate` over the conversation so far, and gpt-5-mini replies once. Every arm shares these replies (`results-r2/memfail/calls-reply.jsonl`).
4. Store. One hippo store per task, as each script's `--shared-user-id` gives one memory user per task. Each storage turn adds the user message and then the reply, as `finalize_conversation` adds them (`src/evaluation.py` 258). hippo's server stores each message as `<role>: <content>`. Arm `hippo-emb`, server flags of dated notes 5.
5. Answer. The top 5 (`NUM_MEMORIES` of every script) for the question, as `- <memory>` lines (the Mem0 wrapper's format at `7ccb5b8`), in the graded template. One user message to `gpt-5-mini-2025-08-07` with no temperature and no reasoning effort, as `OpenAILLM.query` sends it; the scripts pass no extra arguments.
6. Judge. Each task's own `analyze_errors.py`, called as its `main()` calls it, with the whole store as the memory list and gpt-5-mini as the model: persona in batches of 20 (`DEFAULT_BATCH_SIZE`), conditional-hard with `--hard`. Its OpenAI client is `LedgerClient`: each judge call is a ledger item with the vendor's strict `json_schema` output, asked through `qa/openai_llm.py`. Before any judge runs, the server's stored count must equal the rebuilt memory list.
7. Score. The share of traces judged `correct`, per Figure 1 panel; persona splits by `question_type`.
8. `qa/openai_llm.py` puts `gpt-5-mini-2025-08-07` in the small free pool (2.5M tokens a day), as OpenAI's help article 10306912 lists it (read 17 Nov).
9. Output: `results-r2/memfail/<arm>/`; the smoke in `results-r2/memfail/smoke/`.

**Deviations that stay.**
- Internal model. The products ran GPT-4.1-mini inside to extract and summarise memories. hippo runs no model at write time and stores each message whole. Its store is longer, so each storage and summary judge prompt, which carries the whole store, is longer too.
- Snapshot. The scripts send the alias `gpt-5-mini`; we pin `gpt-5-mini-2025-08-07`, its one snapshot. OpenAI shuts that snapshot down on 11 Dec 2026 (deprecations page, read 17 Nov), so a full run must finish before then.
- Retries. The vendor judges retry a failed call 3 times (persona: 12, with waits). Here each call has 3 asks in the ledger, the first valid reply counts, and a vendor retry reads the same ledger reply. A call with no valid reply marks its trace `analysis_error`, and the score lists it.
- Repeated prompts. A judge prompt sent twice gets one ledger reply; the vendor run would sample it twice.
- Sampling. gpt-5-mini answers vary run to run. The paper made one answer per question, and so do we.

**Order.** `replies`; then for `hippo-emb`: `ingest`, `retrieve`, `answer`, `judge`, `score`; then `bm25`. A smoke runs first: each task's first question, over only the storage conversations that hold its facts (11 facts in all). The smoke writes integrity counts and tokens only, never a score. Its questions are the `memfail` key of `smoke_excluded.json` and stay out of the primary.
Smoke items, excluded: `coexisting-000`, `conditional-000`, `conditional-hard-000`, `persona-000` and `long-hop-000`. They are each task's question 0.

**Tests.** `tests/test_memfail.py`. They fail if the clone leaves its pin, if the test-taker prompt's text changes, if a task stops building the paper's question counts, if the answer or a judge leaves with another model, a temperature, or another message or `response_format` shape, if the memory lines or the rebuilt store change format, if a persona batch counts as valid without a verdict for every id, if the judge client stops reading the first valid reply or stops listing open calls, or if threads asking one schema stop sharing one ledger.

**Calls.** Before the smoke, from the real stores: the storage and summary checks each carry the whole task store, 2 per fact (persona 2 per batch of 20). With gpt-5-mini replies of 100, 200 or 400 tokens that is 57M, 100M or 185M input tokens, so 23, 40 or 74 days of the whole free small pool, or $14, $25 or $46 of input at list price ($0.25 and $2.00 per million). The snapshot shuts down 24 days after the 18 Nov reset, and other lanes share the pool, so a free-only full run cannot finish in time even at 100-token replies. The smoke's `estimate` replaces this bound with its measured reply length.

**Smoke.** Started 17 Nov 21:02 UTC by `results-r2/run-memfail-smoke.sh`; it waits at the free-token cap for the 00:00 UTC free day, then writes `results-r2/memfail/smoke/hippo-emb/smoke.txt` and `smoke/estimate.txt`.

**Read before this note.** At `61ab3028`: `src/evaluation.py`, `src/llm.py`, `src/prompt_templates.py`, `src/dataset.py`, the four `evaluate_*.py` scripts and their shell scripts, the four `analyze_errors.py` judges, and the Mem0 wrapper in `src/memory.py` at `7ccb5b8`. The paper's text, Table 2, Figure 1 and Appendix D (arXiv v1 HTML).
