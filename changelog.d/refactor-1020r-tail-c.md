### Changed

- **Only eval callers read the `HIPPO_ABLATE_*` switches and `HIPPO_EVAL_RECENCY_DAYS`.** The `hippo` CLI's other verbs, `hippo serve`, MCP, the dashboard and the sleep child now score and rank by the production model whatever those variables hold; `hippo eval`, the package entries and `dist/entry/eval-scripts.js` still honour them. See `docs/UPGRADING-3.0.md`.
