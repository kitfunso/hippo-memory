### Documentation

- **The 17 ways CLI, MCP and HTTP recall differ today are written down and pinned by tests, with no change in behaviour.** `docs/recall-surface-differences.md` lists them, and `tests/recall-surface-parity-golden.test.ts` pins each surface's output, order, scores, audit rows, session hints and input checks on one store. The ranker eval that will pick the single recall ranker is pre-registered in `docs/evals/2026-10-04-q3b-ranker-floor-prereg.md`, before any run.
