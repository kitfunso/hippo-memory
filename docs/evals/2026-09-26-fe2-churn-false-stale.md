# FE2 churn staleness: false-stale rate on a real store (2026-09-26)

Measured before merge, on a copy of the founder's global store (2,217 memories). The copy was made in a temp directory and the real store was never opened for writing. FE2 ships off by default, and this number is the baseline FE3 has to beat before it can ship on.

**Method.**
- **Detector run:** `detectChurnStale(..., { dryRun: true })` ran once for each of 9 projects that had a git repo on disk, against that repo's HEAD. It checked 1,106 memories, the ones with a matching `origin_project`. The 1,009 memories with an empty owner are never checked.
- **Judging:** one Opus judge read every flagged memory. It checked the flagged file's git log and its diff since the memory's anchor, then labelled the claim:
  - STILL-TRUE: a false stale.
  - NOW-WRONG-OR-DOUBTFUL: a true stale.
  - MISATTRIBUTED: the matched path is not what the memory is about.
- **Privacy:** the labels stay off-repo because the memories are private.

**Result.** The detector flagged 73 of the 1,106 memories: 69 for a changed file and 4 for a deleted one. No symbol-gone or script-gone evidence fired.

| Label | All | file-changed | file-deleted |
|---|---:|---:|---:|
| STILL-TRUE | 44 | 42 | 2 |
| NOW-WRONG-OR-DOUBTFUL | 18 | 18 | 0 |
| MISATTRIBUTED | 11 | 9 | 2 |

**The false-stale rate is 44/73 = 60%, or 55/73 = 75% when misattributions count as false.** One flag in four is right. File-level churn is too blunt to be a default.

**Why the false stales happen.** The judge's three patterns:
1. **Hub files.** The memory names a file that is edited all the time for unrelated reasons: roadmaps, TODO lists, CLAUDE.md, CI config, the large CLI source. The line the memory relies on is still there.
2. **Records of past events.** The memory records a ship, a review, a fix or a failed attempt. A later edit to the file cannot make that record untrue, and sometimes the flagging commit is the very fix the memory describes.
3. **Incidental paths.** The path is a passing mention, such as a log line, a grep target, or a file with the same name in another project.

**What FE3 should test.**
- Skip event records (kind or content shape).
- Require the change to touch the lines or symbol the memory names, not only the file.
- Down-weight files above a churn threshold.

The detection run also caught a real bug before merge. Path extraction cut `.json` and `.tsx` down to `.js` and `.ts`, which lost 6 flags. It was fixed, and the table above is from the fixed code.
