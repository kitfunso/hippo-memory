### Fixed

- **LongMemEval hit scoring matches session tags exactly.** `evaluate_retrieval.py`, `paired_hits.mjs` and `merge_audit.mjs` also counted a tag that merely contained the answer session id, so `answer_x` credited its abstention twin `answer_x_abs`. The bias is at most 1.2 pp on the pooled oracle store.

### Documentation

- **Pre-register round 2 of the mechanism audit:** a replication from the released code, the recency factor, decay and the outcome nudge on their own, lookalikes dated inside v1's window, and physics against cosine-only on session and per-turn stores. `docs/evals/2026-09-23-mechanism-audit-round2-prereg.md` locks the lanes, gates and rule. Adds eval-only switches (`HIPPO_ABLATE_RECENCY`, `HIPPO_EVAL_RECENCY_DAYS`), three E1 arms, an opt-in generator window and a per-turn store builder. Defaults are unchanged.
