# Z0 checker identity: content read with a parser

Date: 2026-10-09
Status: accepted
Links: `scripts/token-eval/checker-identity.mjs` (`checkerIdentity`); `benchmarks/token-eval/README.md`, "Checker identity"; commits `cb33528d`, `f91c283c`, `423f1972`, `c856954b`, `43b0d90c`

## Context
A lesson checker is a script that gives a pass, fail or na verdict on a diff.
The Z0 G5 regrade (prereg 166) must know whether a checker changed after the run.
Six places read that answer through one function: the resume key of a regrade row, the `checker-changed` gate, the post-fix test for an unchanged checker, the `checkerSha` field of each row, the reader's new-round test, and the freeze check before a post-fix pass.

The answer can be wrong in two directions.
An identity that misses a change reuses a stale verdict in silence.
An identity that reports a change where there is none faults every cell of a run.

## Decision
The identity is one hash of the entry script's extension, the entry script's bytes, each local file the script reaches, and the args.
The harness finds those files with the `typescript` 5 parser. It follows every `import`, `export ... from`, `import()` and `require()` that names a local file as a plain string.
A followed file counts by its bytes and by its path from the entry script's folder.
An import that the harness cannot hash stops the tasks-file load with an error that names the file and the reason.

This is the third design. The first two each failed in one of the two directions.

1. **Bytes, args and the path as written** (`cb33528d`, `f91c283c`). The hash held the script's bytes, its args and `check.script` as the tasks file spelled it. With the path in the hash, a results folder moved or copied to another place could read every checker as changed. A changed helper file did not change the identity at all.
2. **Content found with two regular expressions** (`423f1972`). The hash dropped the path and added each local file reached through a literal relative import. A moved folder then read as unchanged. The two expressions missed real imports, so a changed helper could still reuse a stale result in silence.
3. **Content found with a parser** (`c856954b`, `43b0d90c`). The parser sees every import form. The harness refuses what it cannot follow, so a miss is an error at load time and never a silent reuse.

## Consequences
Loading a tasks file needs the `typescript` dev dependency, version 5, with its parser API. Without it the load stops with an error.
Some code that node runs stops the load, because the parser refuses it or reads it another way. The README lists the known examples and the edit that fixes each one.
Node built-ins, packages and files that a checker reads at run time stay outside the identity. After a change there, the operator changes an arg or the entry script.
An identity written by an earlier design never equals one from this design. A results folder that an older build graded faults `checker-changed` on every cell that has a lesson and must be run again.
