# E1: the longitudinal lifecycle test

E1 is the synthetic test behind the paper's lifecycle claims. Each seed generates 300 facts over 20 simulated weekly sessions. Facts get updated and contradicted, lookalike memories compete with them, some memories are marked good or bad, and after every session a read-only probe asks for each fact's current value. It runs locally on CPU: no model, no API key.

## Run it

From a checkout of the release under test:

```bash
npm ci && npm run build
node scripts/e1-lifecycle/run.mjs --arms full,bm25-static --half-life 365 --seeds 1 --out-dir e1-out
node scripts/e1-lifecycle/compare.mjs --a e1-out:full --b e1-out:bm25-static --seeds 1
```

- `--half-life` defaults to 7 days, the setting the June runs used. Pass 365 to test the shipped default.
- Each arm and seed writes `<arm>-seed<n>.json`: every session's metrics, plus one row per probe for the last session.
- `compare.mjs` prints each metric's A minus B with 95% and 99% intervals, from a bootstrap over seeds and then probes. For trap persistence, stale intrusion and contradiction intrusion, lower is better.
- The arms, and what each one switches off, are listed at the top of `run.mjs`.

## Registered runs

Every E1 claim comes from a registration in `docs/evals/` that fixes its seeds, arms, commands and decision rule before any run. The latest is `2026-09-28-e1-release-confirmation-prereg.md`. Its Commands section reruns all 320 runs and every comparison, and `confirm-check.mjs` holds its checks on run metadata and control arms. With 20 runs at a time on a 24-thread desktop, the 320 runs took just under 2 hours; the result is `2026-09-28-e1-release-confirmation-result.md`.

This README and the result documents came after the code they describe, so a checkout of a registered run's commit holds neither: check out the commit for the code and read these files from `master`. A rerun matches the registered files in every field except `meta.ranAt`, the time it finished.
