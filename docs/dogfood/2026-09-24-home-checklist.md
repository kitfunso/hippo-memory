# Things to run at home (from the 2026-09-24 session)

These need your machine: an OpenAI key, HuggingFace downloads, Docker, or your own Claude Code setup. The cloud sandbox has none of them.

## 1. Merge and release
- [x] Review and merge PR #227, then release. Run `npm run build:all` first. Merged 2026-09-24, released in 1.46.0.
- [ ] npmjs.com: open hippo-memory's settings, then Trusted publishing. Add GitHub Actions for `kitfunso/hippo-memory` with workflow `npm-publish.yml`. From then on, a `v<x.y.z>` tag publishes with provenance. Added 2026-09-25, but the next publish was still refused: see section 0 of `2026-09-25-home-checklist.md`.
- [x] GitHub: open Settings, then Security, and turn on private vulnerability reporting. `SECURITY.md` points there. Turned on 2026-09-25 through the API.

## 2. Check automatic capture on your machine
- [ ] Follow `docs/dogfood/2026-09-24-verify-auto-capture.md`: `hippo doctor`, a real `/compact`, and a real tool failure.
- [ ] After `/compact`, look for the line "Hippo saved your task snapshot … before compacting".

## 3. Public benchmarks, the registered run
Plan: `docs/evals/2026-09-24-public-benchmarks-prereg.md`.
- [ ] Wait for the decay default decision: `docs/evals/2026-09-24-decay-default-result.md` and prereg-2. Hippo's 7-day default costs it 7 points of retrieval on LoCoMo at 10 memories.
- [ ] Run the LoCoMo trial: `OPENAI_API_KEY=... benchmarks/public/run-locomo-trial.sh`. It uses gpt-4o-mini, costs about $10 to $15, and adds Mem0's open-source arm if Docker is running. Codex can run this script as is.
- [ ] Run LoCoMo with the registered model: the same script with `gpt-5`, priced first from the trial's token counts.
- [ ] Run LongMemEval-S and BEAM (1M and 10M) through the same runner. The data comes from HuggingFace, which the sandbox blocks. `benchmarks/public/README.md` has the commands; the script does not cover them yet.
- [ ] Rescore LongMemEval with its authors' `src/evaluation/evaluate_qa.py`, using gpt-4o.
- [ ] Publish every result, including a loss. Add it to the README's benchmark table with its setup.

## 4. TE5, the experiment that matters for selling
- [ ] Price a 10-task TE5 pilot on your desktop: `scripts/token-eval/ab-run.mjs`, protocol in `docs/evals/2026-09-23-te5-token-ab-preregistration.md`.

## 5. Company (your playbook page)
- [ ] Check your employment contract for IP clauses.
- [ ] IP assignment to Kitfunso Ltd, with a solicitor.
- [ ] Start talking to design partners.
