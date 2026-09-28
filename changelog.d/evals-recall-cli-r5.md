### Documentation

- **LongMemEval-S R@5 of `hippo recall` itself, next to the benchmark scripts' 98.0%.** On the same 500 questions and scorer, recall with its defaults scores 85.6% on a default install and 87.6% with MiniLM. Its 4,000-token budget keeps the top session and then only short ones, so R@5 lands at R@1; with the budget lifted the same rankings score 96.8% and 97.4%. Pre-registration, result and script: `docs/evals/2026-09-28-recall-cli-longmemeval-*` and `benchmarks/longmemeval/recall_cli_haystack.py`.
