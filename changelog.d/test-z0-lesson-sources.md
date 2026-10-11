### Added

- **Z0 lesson sources are fixed before authoring.** `docs/evals/z0-lesson-sources.md` publishes the one transform from a maintainer's line to a lesson rule, the fixed teach reasons and the four template lessons with their reversals (stage 2 plan D4). `scripts/token-eval/lesson-sources.mjs --tasks FILE --origins FILE` checks that each lesson's rule and reason follow them word for word. It also checks each maintainer rule's recorded line against a full clone at its commit.
