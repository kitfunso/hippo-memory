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
- A statement that holds no rule or preference word and passes the code or limit cue stays a row tagged `captured-note`, with no pin and no `from-user` tag. Other statements store nothing.
- A captured note stays out of every `hippo context` read, so `--auto` and the recent list do not print it, and it does not merge or share. Two reviews each found a new path that printed it, so the check sits in the read admission and the context load. A matching prompt can still bring it back, marked as a past observation, so a one-off order can still print there. Keeping it reachable is deliberate: it is the only way a correction with no rule word reaches a later session without a model.
- Rule words, preferences that name code or limit a choice, and model picks can still pin.
- Stored rows are not repaired. `hippo forget` removes them.

## Consequences
- **Z0 round 3:** its A2 stores the teach message through this route (`task.mjs:208`, per hippo-evals), and prereg item 4 needs A2 to equal a master build. After this change, r3 reads the frozen build at `z0-r3-freeze`, which is not what master ships. An r3 pass shows that a stored rule stops a repeat. It does not show this route is fit to ship, because the teach text is one clean sentence.
- **Z0 teach messages (measured by hippo-evals, not rerun here):** over the 2 runner teach forms and the 6 dev sets, `extractFromTexts` only, 46 messages. Frozen build: 28 rule with `follow-up`, 10 rule, 8 nothing. This build: 28 note with `follow-up`, 10 rule, 8 nothing. So 28 of 46 teach messages stop pinning. How often an unpinned note still surfaces, and what that does to repeat mistakes, is not measured. hippo-evals plans a dev read on the tagged build beside the frozen one.
- A later correction with no rule word no longer pins. This is a real loss of recall for rules, and `capture.followUpRules` is the upgrade path.
- Later turns with a rule word can still be one-off orders, a limit preference such as "Skip the review before you merge this one" can still pin, and so can pasted prose with a preference word. Most of the 6 replay rows are of these kinds.
