# A later statement with no rule word stays an unpinned note

Date: 2026-11-04
Status: accepted
Links: `changelog.d/fix-capture-no-pin-statements.md`; `scripts/capture-replay.mjs`

## Context
Since 3.2.0, `followUpRule` in `src/surface/capture/extract.ts` turned a later-turn statement into a pinned user rule when it had 4 or more words and a limit cue, or 2 or more words and a code cue. A pinned user rule prints first in every later session of that project, as a plain instruction.

## Evidence
- Replay of 27 real sessions on one machine, chosen as the newest with 12 to 400 typed turns and a median turn under 220 characters. 3.3.1 pinned 83 rows: 78 from this route and 5 from rule words.
- One reader (the release author) read a random 40 of the 83 and judged about 4 to be lasting rules. This judgement has no second reader. The rows included "stop, delete everything related to this project", which is unsafe to print as an instruction.
- The fixed build pinned 6 rows on the same list: 5 with a rule word and 1 preference that limits a choice.
- A live model-capture test showed that `capture.followUpRules` adds picks but cannot remove pattern rows, so it could not fix this.
- To repeat: `node scripts/capture-replay.mjs <file of transcript paths> [hippo.js]`.

## Decision
- A statement that holds no rule or preference word stays a row with category `note`, with no pin and no `from-user` tag. Recall can still find it.
- Rule words, preferences that name code or limit a choice, and model picks can still pin.
- Stored rows are not repaired. `hippo forget` removes them.

## Consequences
- **Z0 round 3:** its A2 stores the teach message through this route (`task.mjs:208`, per hippo-evals), and prereg item 4 needs A2 to equal a master build. After this change, r3 reads the frozen build at `z0-r3-freeze`, which is not what master ships. An r3 pass shows that a stored rule stops a repeat. It does not show this route is fit to ship, because the teach text is one clean sentence.
- A later correction with no rule word no longer pins. This is a real loss of recall for rules, and `capture.followUpRules` is the upgrade path.
- Later turns with a rule word can still be one-off orders, and pasted prose with a preference word can still pin. Most of the 6 replay rows are of these kinds.
