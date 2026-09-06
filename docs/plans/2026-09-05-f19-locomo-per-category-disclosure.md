# F19: LoCoMo per-category disclosure table (README + website)

Episode `01M1SNEVHH9PV1BWJXFQG6WG33` (loop `hippoloop-20260904T205515Z`, A3 item 11). Docs only.

## Problem

Hippo's own LoCoMo result exists in two places only: the full per-category table in
`benchmarks/LOCOMO_INVESTIGATION.md` (lines 147-156) and the overall number in
`benchmarks/README.md` (line 102). `README.md` mentions LoCoMo only in competitor cells of the
Comparison row (line 786) and its Benchmarks section (heading line 799, sentence line 801) says "Two benchmarks", covering
LongMemEval and Sequential Learning. `website/src/pages/benchmarks.astro` is LongMemEval-only.
A reader of the README or the site cannot see how hippo does on LoCoMo, per category, or under
what conditions the number was measured.

## Source facts (read 2026-09-05 from origin/master d3c77ba)

| Category | n | v1.25.0 evidence recall@5 | 3 dp |
|---|---:|---:|---:|
| single-hop | 282 | 0.238882 | 0.239 |
| multi-hop | 321 | 0.490914 | 0.491 |
| temporal-reasoning | 92 | 0.169384 | 0.169 |
| open-domain | 841 | 0.450258 | 0.450 |
| adversarial | 446 | 0.226457 | 0.226 |
| overall | 1982 | 0.363369 | 0.363 |

Source: `benchmarks/LOCOMO_INVESTIGATION.md:147-156` ("Per-category (same rescore, canonical
numbers)"), rescored by `score_evidence.py`. 3 dp matches the precision `benchmarks/README.md:102`
already uses for the overall number.

Conditions that must travel with the table:

- **Build and date:** hippo v1.25.0 (`f20d9e9`), run 2026-07-05 (`LOCOMO_INVESTIGATION.md:5, 92`),
  93.6 min, 1,982 scored QAs of 1,986 (`:102-118`).
- **Embedder:** the zero-dependency default. `benchmarks/locomo/run.py` `hippo_init` runs
  `hippo init --no-hooks --no-schedule --no-learn` and writes a config only for `--salience`
  (run.py:186-204), so `config.embeddings.provider` stays `local` (CHANGELOG 1.23.0) and the model
  is `src/embeddings.ts:27` `DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2'`.
- **n = 1:** a single run, a point estimate. Pre-1.26.0 builds showed run-to-run spread
  (conversation 1 repeated 4 times: mean 0.3630, range 0.3401-0.3820, stdev 0.0175;
  `LOCOMO_INVESTIGATION.md:181-193`). v1.26.0 removed the dominant variance source; the table has
  not been re-run on a post-1.26.0 build.
- **Harness bug present at run time:** `run.py` used `shell=True` on Windows and cmd.exe truncated
  turns at embedded newlines, so 0.9% of stored rows lost their tags (`LOCOMO_INVESTIGATION.md:20-30, 215-244`; fixed in PR #126, commit `9da6d3f`
  "fix: locomo harness newline truncation").
- **Metric:** deterministic gold-`dia_id` evidence recall@5, no LLM judge. Not comparable to the
  LLM-as-judge numbers Mem0 and Letta publish (`LOCOMO_INVESTIGATION.md:166-170`). Informational
  only, gates no feature (`:11-12`).

## Changes

1. `README.md`, Benchmarks section (line 799 onward):
   - "Two benchmarks testing two different things" -> "Three benchmarks testing three different
     things".
   - New `### LoCoMo (conversational evidence recall)` subsection between the LongMemEval and
     Sequential Learning subsections: one paragraph naming the dataset, the metric and the
     conditions above; the 6-row table (Category, n, evidence recall@5); a closing line linking
     `benchmarks/LOCOMO_INVESTIGATION.md` and `benchmarks/locomo/`.
2. `website/src/pages/benchmarks.astro`:
   - Frontmatter: `const locomo = [...]` rows (category, n, r5) with a comment citing the doc,
     mirroring the existing `perHaystack` / `globalPool` consts.
   - New section at the end of the page, after "Reproduce it" (the LongMemEval sections and their
     reproduce block stay contiguous; the LoCoMo section carries its own doc link): heading "LoCoMo: conversational evidence recall", the same table markup as the
     per-haystack section, a caveat paragraph (v1.25.0, 2026-07-05, MiniLM default, single run,
     no LLM judge), a link to `LOCOMO_INVESTIGATION.md` on GitHub.
   - Hero paragraph (line 54) gains "and LoCoMo" so the page's own framing matches its content.
     `title`, `description`, `heroChips` and `jsonLd` stay LongMemEval-led: the headline numbers
     do not change.
3. `website/scripts/check-readme-sync.mjs`: extend the drift guard so the `locomo` rows in
   `benchmarks.astro` must each match one README `### LoCoMo` table line as a whole
   (`| category | n | r5 |`), so a swapped or copied score fails, not only a missing one (codex
   review round 1 P2). A new parallel check block in the same best-effort text-extraction style as the
   existing `cells:` check (second source file, second README section scope); fails the website
   build on drift. This is the repo's established pattern for site-vs-README numbers.
4. `CHANGELOG.md`: new `## 1.38.3 - unreleased` heading with an `### Added` bullet (version bump
   happens at the batch deploy gate).

No `src/` change. No version bump. No ROADMAP edit: F19 is tracked in the loop backlog, ROADMAP has
no F-list entry for it.

## Verification

- `node website/scripts/check-readme-sync.mjs` passes in the worktree, and fails when one astro
  r5 cell is deliberately changed (mutation), then passes again after revert.
- `npm --prefix website run build` (runs the sync check, then `astro build`) succeeds; the built
  `dist/benchmarks/index.html` contains the six category rows.
- A scratch python check reads the README table and `LOCOMO_INVESTIGATION.md:149-156` and
  asserts each README cell equals the doc value rounded to 3 dp.
- Grep the diff for em dashes (none allowed in the site copy or CHANGELOG) and for
  `sk-|api_key=|password=`.

## Risks

- Publishing a v1.25.0 number on a v1.38.x README could read as current. Mitigation: the build,
  date and "not re-run since" line sit in the same paragraph as the table, on both surfaces.
- The website `astro build` needs `npm ci` in `website/` inside the worktree (no build cache).
  Cost: one install, a few minutes.
