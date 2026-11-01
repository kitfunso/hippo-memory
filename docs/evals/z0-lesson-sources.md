# Z0 lesson sources

Fixed before any family is authored (stage 2 plan D4; prereg lines 50-52 and 64). The code is `scripts/token-eval/lesson-sources.mjs`, and `tests/token-eval-lesson-sources.test.ts` fails if this page and the code differ.

## Maintainer rules: one transform

A maintainer lesson's rule is its source line, taken from the repository's `AGENTS.md`, `CLAUDE.md`, `.cursor/rules` or `CONTRIBUTING.md`, under this transform and nothing else:

1. Drop one leading list marker (`-`, `*`, `+`, `1.` or `1)`) and the space after it.
2. Drop every `**`.
3. Collapse each run of whitespace, line breaks included, to one space, and trim.
4. Drop one trailing period.

Wording, case and code spans are never changed. A rule that wraps over several lines records the line range. Each lesson records the repository, commit, file, line range and the exact text. `node scripts/token-eval/lesson-sources.mjs --tasks FILE --origins FILE` checks that text against a full clone at that commit.

## Fixed reasons

The teach message is `No: <rule>, because <reason>. Please fix it.` or `Yes, keep doing that: <rule>, because <reason>.` (prereg 106-107). For a maintainer rule the reason is fixed:

- Root lesson: `the project's maintainers require it`
- Reversal taken from a real change in the rule file's history: `the project's maintainers changed this rule`

## Template lessons: the list

Template families are at most one third of the families. Each fills the slots in braces from the repository and changes nothing else.

| Template | Rule | Reason |
|---|---|---|
| test-flag | ``Run the tests with `{command}`, not the bare `{bare}` `` | `the bare command leaves out part of the test setup` |
| generated | ``Never edit `{path}` by hand; regenerate it with `{command}` `` | `the file is generated, so hand edits are lost at the next regeneration` |
| changelog-fragment | ``Put each changelog entry in a new file under `{dir}`, never in `{file}` `` | `the release script builds the changelog from those files` |
| logger | ``Log through `{logger}`, never `{console}` `` | `the project logger keeps output consistent and filterable` |

A reversal family takes its reversal from a real change in the rule file's git history where one exists. Otherwise it uses the template's reversal, with the reason `the project changed this setup`:

| Template | Reversal rule |
|---|---|
| test-flag | ``Run the tests with `{newCommand}`; `{command}` is no longer the test command`` |
| generated | ``Edit `{path}` by hand; it is no longer generated`` |
| changelog-fragment | ``Add changelog entries to `{file}` directly; `{dir}` is no longer used`` |
| logger | ``Log through `{newLogger}`; `{logger}` is no longer used`` |
