# Z0 round 3 result: fewer repeat mistakes at no extra cost, but not from hippo's lessons

Date: 8 Nov 2026. Read: the frozen analyzer on 29 wave 1 runs and 6 Amendment E reruns, after G5 reader round 2.
Full log: `z0-scored-set-record.md`, entries to 8 Nov 20:52. Prereg: `2026-09-29-z0-built-in-memory-prereg.md` and
`2026-11-02-z0-round3-prereg.md` (Amendments A to E). Report: `C:/z0-runs/scored/r3-final/unblind.stdout`.

## Headline

- **H1 is a small win.** On the family's first apply, hippo with built-in memory (A2) makes 14.9 points fewer repeat
  mistakes than built-in memory alone (A1): -0.149 [-0.243, -0.055], adjusted p 0.006 and 0.005 under the two codings,
  148 units. The prereg's full-win line is 15 points.
- **The lessons are not shown to cause it.** A2 against sham hippo (A5, hippo with capture removed) is 0.009
  [-0.052, 0.070]. By prereg line 148 the result reads: "installing hippo changed behaviour, and this run cannot say its
  lessons did".
- **No extra cost.** H3 (secondary) A2/A1 is 1.006 [0.964, 1.049]. H4 passes: on tasks with no lesson, the cost ratio
  is 1.009 [0.978, 1.040], under the 1.10 bound, and the resolve difference is 0.000 [-0.012, 0.012].
- **Every gate passes.** G1, G2, G3 (2 of 87 leaked after Amendment E), G4 (worst invalid share 3.9%) and G5 (14 of
  170 after round 2).

## Repeat-mistake rates by arm

First applies 2 to 4 tasks after the teach (`bySinceTeach`, violation coding): A0 no memory 0.832, A1 built-in 0.211,
A2 hippo 0.111, A5 sham hippo 0.094, A4 perfect memory 0.068. A4 against A1 is -0.205 [-0.303, -0.108], so a memory
that holds the taught rule leaves about 4 points (0.111 against 0.068) that A2 does not take.

## Sensitivity read (Amendment B, no verdict)

18 positions lost a prompt hook (7 A2 and 11 A5 sessions of 2,151). Without them, H1 is -0.161 [-0.254, -0.067],
adjusted p 0.003, and A2 against A5 is 0.009 [-0.029, 0.047]. Report: `r3-final/sensitivity.stdout`.

## What went wrong in the run

- **Leaks.** 6 sequence-seeds leaked at first; Amendment E reran them once and 2 leaked again (G3 2 of 87).
- **Setup failures.** Every session of a Python run shares one virtual environment, and an agent's `uv` command broke
  it: `q145-w1` lost 143 of 156 records and `q256-w1` 24. The analyzer removes invalid cells from every arm at once.
- **G5 round 2.** Round 1 failed at 18 of 170. The `q256-f1-l1` checker counted `uv run python -m pytest` and
  `uv run coverage run -m pytest` as bare pytest; the fix, a post-fix regrade and a blind reader round 2 on `q256`
  brought G5 to 14 of 170. `q118-f1-l1` was right and stays as it was.

## What this means for hippo

The gain over built-in memory is real at this size, but the sham arm gets the same gain, so it comes from what
installing hippo does to the agent (its hooks and injected instructions), not from the lessons hippo captured.
Round 4 needs A2 against A5 as its primary contrast, and a per-session virtual environment in the harness.
