# AGENTS.md - Hippo

## Project
- `hippo-memory`, a TypeScript memory system and CLI with UI, integrations, benchmarks, and evaluation harnesses.
- Read `README.md`, `PLAN.md`, `ROADMAP.md`, and relevant docs before broad product or architecture changes.
- Work plane boundary: `docs/plans/2026-09-12-work-plane-boundary.md` (ROADMAP Part VII, Track W, W0).

## Commands
```bash
npm run build
npm test
npm run build:ui
npm run build:all
npm run smoke:pack
npm run smoke:openclaw-install
```

## Rules
- Preserve public CLI and package APIs unless the user asks for a breaking change.
- Document public APIs with JSDoc.
- Prefer focused tests in `tests/` or nearby integration/eval harnesses before changing memory behavior.
- Name a new test file after the behaviour it pins, not the ticket (`store-stats-concurrency.test.ts`, not `a7-t3.test.ts`). Seed test stores through `initStore`, `createMemory` and `writeEntry`; write raw SQL only when the test is about SQL.
- Do not commit generated `dist/` or UI build output unless the repo expects it for a release.
- A PR's changelog entry goes in its own `changelog.d/<branch-with-dashes>.md`, never in `CHANGELOG.md`; the release commit folds them in (`changelog.d/README.md`).
- CI fails when any oxlint rule's hit count rises above `.oxlint-baseline.json`. Fix new hits in the files you touch; after clearing old ones, `node scripts/check-lint-ratchet.mjs --update` and commit the lower baseline.
- An eval that reads host transcripts (`~/.claude/projects/*.jsonl`) copies its corpus outside the repo at registration and names the copy in the prereg: Claude Code deletes sessions after 30 days by default, so a live-path corpus cannot be re-run.
- Use Hippo memory commands when useful, but do not store secrets.

## Never Do
- Never store secrets, API keys, tokens, raw private emails, or sensitive personal data in Hippo memories.
- Never break the public `hippo` CLI command names without a migration path.
- Never auto-graduate long-term lessons without evidence and rationale.
- Never delete memory history when archiving or weakening would preserve recoverability.
- Never ship release changes without `npm run build:all`.

<!-- hippo:start -->
## Project Memory (Hippo)

At the start of every task, run:
```bash
hippo context --auto --budget 1500
```
Read the output before writing any code.

On errors or unexpected behaviour:
```bash
hippo remember "<description of what went wrong>" --error
```

On task completion:
```bash
hippo outcome --good
```

When Hippo's Codex wrapper is installed, session-end capture runs automatically.
If the wrapper is not installed, capture a brief summary manually:
```bash
hippo capture --stdin <<< '<decisions, errors, lessons — 2-5 bullets>'
```
<!-- hippo:end -->
