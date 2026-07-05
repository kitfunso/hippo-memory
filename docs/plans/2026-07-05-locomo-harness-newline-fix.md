# LoCoMo harness newline-truncation fix + published-finding correction

Status: Draft v2 (episode 01KWS4VK43CRKKK87DNZM10A8S, plan stage, revised after plan-eng-critic round 1)
Date: 2026-07-05
Branch: `fix/remember-tag-loss` (worktree off origin/master `dbb489e`)

## Root cause (proven at discover; reframes the episode)

The "silent user-tag loss on `remember`" published in PR #124 is NOT a hippo
bug. `benchmarks/locomo/run.py`'s `run_hippo` uses
`shell=(sys.platform == "win32")`; cmd.exe truncates the built command line
at the first embedded newline, so any turn whose source text ends with
`"\n"` silently loses its closing quote and EVERY subsequent `--tag`
argument (exit code stays 0 — only the first line executes). Proof chain:

- All 10 conv-41 tagless rows' SOURCE texts end with trailing newline(s);
  stored contents are newline-stripped; healthy rows have no trailing
  newline. Same for conv-43 (2 rows).
- Deterministic 2-row-store repro: identical content, `shell=True` → row
  with only auto `path:*` tags + stripped newline; `shell=False` → full
  tags + newline preserved.
- Full-sequence replays: `shell=False` 0/663 tagless; `shell=True`
  (uncontended) exactly the same 10/663 as the original runs.
- Hippo-side exoneration (debugger enumeration, complete): exactly one SQL
  statement writes `memories.tags_json` (`upsertEntryRow`,
  src/store.ts:992); id entropy makes its ON CONFLICT branch unreachable
  across distinct `remember` calls; both files→DB import paths are
  hard-gated (empty-DB-only / new-ids-only); the markdown mirror of an
  affected row carries the SAME stripped tags, proving the loss predates
  `writeEntry`; `parseArgs` is positional and content-blind.

Published-number impact: NONE on the canonical baseline — the post-hoc
scorer's content-recovery fallback absorbed tag-less rows in both April and
July runs. The tie-breaking nondeterminism follow-up SURVIVES (truncation
is deterministic and identical across repeat runs).

## Exposure audit (which call sites actually pass content via argv)

Verified per-script (plan-eng-critic round 1 corrected the first draft's
over-broad "fix every shell= site" framing — exposure is a function of the
content-passing MECHANISM, not of newlines in data):

| Site | Content path | Exposed? | Action |
|---|---|---|---|
| `locomo/run.py` `run_hippo` (:157-185; used by remember + recall) | content + tags via **argv** | YES (the proven bug) | fix via helper |
| `locomo/audit_matched_stores.py` (invocation `run_hippo` :46-77; argv content `remember_turn` :105-117) | content via **argv**, multi-build `--hippo-cmd` | YES | fix via helper (explicit command param) |
| `locomo/run.py` :406, :506 (claude / command judge) | prompt via **stdin** (`input=`), not a hippo call | no | scope OUT, rationale documented |
| `longmemeval/ingest.py` (:110 area) | `remember -` content via **stdin** | no | scope OUT, documented as unexposed |
| `longmemeval/ingest_direct.py`, `ingest_enriched.py` (incl. :160 seed) | direct sqlite INSERT; only fixed dummy strings via argv | no | scope OUT, documented |
| `longmemeval/retrieve.py` (:90, :104) | queries via argv (single-line question strings) | not content-exposed in practice | document ONLY — no code change to retrieve.py in this PR (a naive shell=False flip would break bare `hippo.cmd` resolution without the helper) |

## Tasks

- **T1 — safe invocation helper (sonnet executor).** New
  `benchmarks/locomo/hippo_subproc.py` (SAME directory as its two
  consumers — imports work exactly like the existing `from run import ...`
  sibling pattern; no sys.path games):
  - `run_hippo_argv(args, *, command=None, env, cwd, timeout, stdin_text=None)`
    — `command` is an explicit argv-prefix list (preserves
    `audit_matched_stores`' multi-build `--hippo-cmd` capability); default
    resolution: `HIPPO_BIN` (shlex.split) else `shutil.which("hippo")`.
  - `shell` is NEVER used. If the resolved default is a `.cmd`/`.bat` shim
    (npm global), REFUSE with a clear error instructing `HIPPO_BIN=` —
    no cmd.exe fallback at all (eliminates the whole metacharacter class:
    newlines, `%` expansion, `^`, embedded quotes — rather than guarding a
    denylist; batch shims always transit cmd.exe, the BatBadBut /
    CVE-2024-24576 class, so no shell= setting makes them safe). If
    resolution yields nothing at all (no `HIPPO_BIN`, `hippo` absent from
    PATH), raise the SAME actionable error — never pass None to subprocess.
  - `locomo/run.py` `run_hippo` and `audit_matched_stores.py` switch to it.
    Judge subprocesses (:406/:506) untouched (stdin-fed, non-hippo).
    Turn text stays byte-exact — no normalization.
- **T2 — regression test (sonnet executor).**
  `benchmarks/locomo/test_hippo_subproc.py` (pytest, self-contained): stub
  HIPPO_BIN (python script dumping `sys.argv` + stdin to a file) receives
  byte-exact: (a) trailing-newline content + 4 tags, (b) `%PATH%`- and
  `100%`-bearing content, (c) interior-newline content; plus (d) the
  `.cmd`-shim refusal raises with the HIPPO_BIN hint; (e) explicit
  `command=` list is used verbatim (no HIPPO_BIN interference); (f) empty
  resolution (no HIPPO_BIN, nothing on PATH) raises the actionable error.
- **T3 — published-finding correction (sonnet executor, same dispatch).**
  - `benchmarks/LOCOMO_INVESTIGATION.md`: dated correction amending the
    2026-07-05 tag-loss paragraph — cause reattributed to the harness;
    the measured rates KEPT as measurements of the harness bug (no silent
    deletion of published measurements); hippo exoneration summary (the
    writer enumeration + mirror-parity fact); numbers-unaffected rationale
    scoped to the canonical rescored metric.
  - `TODOS.md`: tag-loss follow-up replaced with a resolution note
    (harness bug, fixed this episode, pointer); tie-breaking follow-up
    KEPT unchanged.
  - `benchmarks/locomo/README.md`: reconcile EVERY assertion of the
    bare-global-`hippo` default with the new refusal behavior — the Setup
    block (:37-43), the "globally installed hippo CLI by default" line
    (:39-40), and Non-negotiable #1 (:106, "Uses globally installed hippo
    CLI") — plus the HIPPO_BIN guidance and .cmd refusal rationale
    (BatBadBut class). A Windows reader following the documented default
    must not hit a refusal the doc elsewhere presents as supported.
  - `benchmarks/README.md` + `LOCOMO_INVESTIGATION.md`: one-paragraph
    exposure-audit table (the mechanism table above) so LongMemEval is
    explicitly documented as UNEXPOSED (stdin / direct-sqlite ingestion) —
    no taint follow-up is filed because no longmemeval script passes
    content via argv.
  - April-era note: same truncation existed in all April locomo runs;
    affected rows likewise absorbed by content recovery. One sentence.
- **T4 — ship.** Single PR: helper + run.py + audit_matched_stores.py +
  test + 4 docs. No `src/` changes, no version bump, no npm publish.
  Deploy = squash-merge.

## Success criteria (falsifiable)

Unit (self-contained pytest):
1. `test_hippo_subproc.py` green: argv fidelity for newline/percent/interior
   cases, `.cmd` refusal, explicit-command override.

Integration (env prerequisite: worktree build + local locomo10.json):
2. The 2-row deterministic repro run through the FIXED `run_hippo` stores
   full tags + preserved trailing newline.
   **Outcome note (post-verification):** tags full — PASS (the bug-fix
   proof). The trailing-newline clause was MIS-SPECIFIED: hippo trims
   content at intake by design (`src/memory.ts:484` `content.trim()`),
   identically in every invocation mode, so stored trailing whitespace was
   never the harness's to preserve. The correct byte-exactness contract is
   at the process boundary (argv reaches hippo intact) — proven by the
   stub-argv unit tests (trailing-newline, interior-newline, %-bearing
   cases). April comparability unaffected (same intake trim then as now).
3. Full 663-turn conv-41 re-ingest through the fixed harness: 0 tagless
   rows (was deterministically 10). **Outcome: PASS — 663/663 rows, 0
   tagless.**

Docs:
4. No remaining claim on master attributing tag loss to hippo's write path
   (grep the corrected files); measured rates preserved as harness-bug data.
5. Exposure-audit table present; no false LongMemEval taint claim anywhere.
6. Tie-breaking follow-up still present in TODOS.md.
7. No `src/` changes.

## Risks

- `.cmd` refusal changes behavior for bare-`hippo`-on-PATH Windows users of
  the harness: they now get an actionable error instead of silent
  mangling — strictly better; documented in the README note.
- Correction wording must not oversell; "numbers unaffected" stays scoped
  to the canonical rescored metric.

## Out of scope

Hippo src/ changes; re-running benchmarks (canonical numbers stand);
longmemeval script refactors beyond documentation (unexposed); the
tie-breaking follow-up (separate episode).
