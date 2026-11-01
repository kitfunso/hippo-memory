### Changed

- **Only eval callers read the `HIPPO_ABLATE_*` switches and `HIPPO_EVAL_RECENCY_DAYS`.** `hippo eval` and the package entries, `dist/entry/eval-scripts.js` among them, still honour them; an entry handed a Context with the caller's own `infra` scores by production unless that `infra` sets `strength` and `rank`. The `hippo` CLI's other verbs, `hippo serve`, MCP, the dashboard and the sleep child now build their ports with the production model and never read them. See `docs/UPGRADING-3.0.md`.
- **`hippo goal` drops control characters from a goal name instead of storing each as `?`.** It now uses the same guard as the hook logs, and a flag given with no value fails with `--<flag> requires a value`, as in the other verbs.
