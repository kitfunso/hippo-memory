"""Micro-eval harness for hippo.

Tier 1 in the eval pyramid:
  Tier 1 (this) - 20-50 fixture QAs, deterministic substring scoring, ~30s.
                  Run on every code change. Targets one mechanic per fixture.
  Tier 2        - LoCoMo stratified subsample (run.py with --conversations 1
                  --sample 10 --score-mode evidence). ~5-10 min, run before PR.
  Tier 3        - LoCoMo full (1982 QAs). ~85 min evidence / ~6h judge.
                  Release gate only.

Each fixture is a JSON file under fixtures/ with shape:

  {
    "name": "decay-basic",
    "mechanic": "decay",                  # decay | recall | consolidation | salience | ...
    "remembers": [                         # ordered hippo remember calls
      "Bob's coffee order is oat milk latte",
      "Alice prefers green tea",
      {"text": "...", "tags": ["auth-rewrite"]},  # object form attaches --tag flags
      {"text": "...", "cwd_subdir": "proj-x/lib"}  # optional, see cwd_subdir below
    ],
    "actions": [                           # optional, run after remembers in order
      {"type": "supersede",
       "remember_index": 0,
       "new_content": "Bob switched to oat milk flat white"}
    ],
    "queries": [
      {"q": "what does Bob drink",
       "must_contain_any": ["oat milk", "latte"],     # at least one in top-k
       "must_not_contain_any": ["espresso"],          # optional, all must be ABSENT
       "top_k": 3,
       "cli_args": ["--include-superseded"],
       "cwd_subdir": "proj-x/lib"}                    # optional, see cwd_subdir below
    ]
  }

cwd_subdir (optional, object-form `remembers` items, `queries` items, and
`recall`-type `actions` items): a relative path such as "proj-x/lib". When
present, the item's hippo subprocess is run with that directory (resolved as
`hippo_home / cwd_subdir`, created via `mkdir(parents=True, exist_ok=True)`)
as its cwd instead of `hippo_home` itself -- this lets a fixture exercise
hippo's cwd-derived path tags (see src/path-context.ts) by writing/querying
memories from different simulated project directories within one fixture's
temp HIPPO_HOME. Rejected (raises ValueError naming the fixture): absolute
paths, paths with a drive letter, and any path containing a '..' segment.
Plain-string `remembers` items and `queries`/`actions` items without the key
keep today's behavior (cwd = hippo_home) unchanged.

Action types:
  - supersede: marks remembers[remember_index] as superseded_by a new memory
               whose content is `new_content`. Sets `entry.superseded_by`
               on the original. Equivalent to `hippo supersede <id> "..."`.
  - outcomes:  applies positive/negative outcomes to remembers[remember_index].
               Calls `hippo outcome --good --id <id>` `good` times and
               `hippo outcome --bad --id <id>` `bad` times. Used by both
               vmPFC value attribution and OFC option-value scenarios.
               Example:
                 {"type": "outcomes", "remember_index": 0, "good": 3, "bad": 0}
  - recall:    runs `hippo recall <query> --limit 1` `times` times. The
               `--limit 1` caps the result set BEFORE markRetrieved() in
               cli.ts, so only the top-ranked match has retrieval_count bumped
               (recall without a limit bumps every returned memory). The
               `query` must rank the target memory at #1 — a unique marker
               token is the canonical pattern. The harness verifies via
               `hippo trace <id>` that retrieval_count >= times. Used by
               pineal-salience scenarios where "salience" emerges from USE
               rather than lexical overlap. Accepts an optional `cwd_subdir`
               (see cwd_subdir above) to run the recall calls from a
               simulated project directory. Example:
                 {"type": "recall", "query": "marker-pineal-1",
                  "remember_index": 0, "times": 3}
  - promote:   runs `hippo promote <id>` (copies remembers[remember_index]
               from its LOCAL store into the per-fixture global store) from
               the SAME cwd the remember was written from (the harness
               tracks each remember's resolved cwd in `remember_cwds`,
               parallel to `remember_ids`). Raises RuntimeError naming the
               fixture if the id was not captured (mirrors the supersede
               precedent above — never passes None to the CLI).
  - forget:    runs `hippo forget <id>` for remembers[remember_index] from
               its tracked cwd. Hard-deletes the memory from that cwd's
               LOCAL store only — a prior `promote` of the same remember
               (if any) is unaffected, since it lives in the global store.
               Same uncaptured-id RuntimeError as `promote`.

  Ordering constraint (actions run in declared order): a `forget` of a
  remember hard-deletes its local id, so any `promote` of that same
  remember MUST be declared BEFORE the `forget` in the fixture's `actions`
  list — a `promote` declared after would try to promote an id the local
  store no longer has.

  Cross-store fixture authoring note: when a fixture's queries compare
  memories that live in different stores (e.g. promoted globals vs.
  untouched locals), keep each competitor's content under 200 chars and
  make them diverge in their first 200 chars — cross-store dedup keys on
  `content.slice(0, 200)` (src/shared.ts:287), so two competitors sharing
  a >=200-char-identical prefix would collapse into one row.

Usage:
  python benchmarks/micro/run.py
  python benchmarks/micro/run.py --filter decay
  python benchmarks/micro/run.py --baseline results/baseline.json   # diff vs baseline

Pass criterion: every query's top-k results must contain at least one
substring from must_contain_any (case-insensitive). If must_not_contain_any
is set, NONE of those substrings may appear in the top-k.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, asdict
from pathlib import Path, PurePosixPath, PureWindowsPath

ROOT = Path(__file__).resolve().parent
FIXTURES_DIR = ROOT / "fixtures"
RESULTS_DIR = ROOT / "results"


def _resolve_hippo_bin() -> list[str]:
    """Resolve the argv prefix used to invoke the hippo CLI.

    Mirrors the BatBadBut shim-detection in benchmarks/locomo/hippo_subproc.py
    (see `resolve_hippo_command`, ~lines 80-102 there): a bare `hippo` name
    that PATH-resolves to a `.cmd`/`.bat` shim cannot be spawned without a
    shell (CreateProcess transits cmd.exe regardless of the `shell=` argument
    passed to subprocess.run -- the BatBadBut / CVE-2024-24576 class), and
    this harness deliberately never sets shell=True. micro/ stays standalone
    (no cross-benchmark import), so the detection is duplicated here rather
    than imported.

    `HIPPO_BIN` always wins when set, with no detection performed. Otherwise:
    resolve the default `hippo` via `shutil.which`; if that fails to resolve
    or resolves to a `.cmd`/`.bat` shim, fall back to `node <repo-root>/bin/
    hippo.js` when that file exists. If it doesn't exist, keep `["hippo"]`
    and let it fail as before (no silent behavior change).
    """
    env_bin = os.environ.get("HIPPO_BIN")
    if env_bin:
        return env_bin.split()

    default = "hippo"
    resolved = shutil.which(default)
    is_shim = resolved is not None and Path(resolved).suffix.lower() in (".cmd", ".bat")
    if resolved is None or is_shim:
        repo_root = ROOT.parent.parent  # benchmarks/micro -> repo root
        hippo_js = repo_root / "bin" / "hippo.js"
        if hippo_js.exists():
            reason = (
                f"default 'hippo' is a {Path(resolved).suffix} shim"
                if is_shim
                else "default 'hippo' was not found on PATH"
            )
            print(
                f"hippo binary: node {hippo_js} ({reason}; "
                f"set HIPPO_BIN to override)",
                file=sys.stderr,
            )
            return ["node", str(hippo_js)]
    return [default]


HIPPO_BIN = _resolve_hippo_bin()


def _sanitize_cwd_subdir(subdir: str, fixture_name: str) -> Path:
    """Validate a fixture's `cwd_subdir` value; return it as a relative Path.

    A fixture may only address a subdirectory under its own temp HIPPO_HOME:
    absolute paths, drive letters, and any '..' segment are rejected.
    Windows-reserved device names (CON, NUL, COM1, ...) are NOT screened here;
    they fail loudly at mkdir with an OS error (fixtures are first-party).
    """
    # Validate under BOTH path flavors so the contract is platform-independent:
    # on a POSIX runner, Windows syntax like 'C:\\repo' or '\\\\server\\share'
    # has no drive/root under PosixPath and would otherwise slip through.
    for flavor in (PureWindowsPath(subdir), PurePosixPath(subdir)):
        if flavor.is_absolute() or flavor.drive or flavor.root:
            raise ValueError(
                f"fixture {fixture_name!r}: cwd_subdir {subdir!r} must be a "
                f"relative path (no drive letter, not absolute)"
            )
        if any(part == ".." for part in flavor.parts):
            raise ValueError(
                f"fixture {fixture_name!r}: cwd_subdir {subdir!r} must not "
                f"contain '..' segments"
            )
    return Path(subdir)


def _resolve_item_cwd(hippo_home: Path, subdir: str | None, fixture_name: str) -> Path:
    """Resolve the subprocess cwd for a remember/query/recall item.

    Returns `hippo_home` unchanged when `subdir` is None (today's behavior).
    Otherwise sanitizes `subdir`, creates `hippo_home / subdir`, and
    auto-initializes a LOCAL hippo store there (idempotent: skipped when
    `.hippo/hippo.db` already exists). Hippo's local store root is strictly
    cwd-derived (`getHippoRoot(cwd) = cwd/.hippo`, src/store.ts:255-257) with
    no ancestor walk-up, so every subdir a fixture addresses needs its own
    initialized store before any remember/recall/promote/forget call against
    it will succeed.
    """
    if subdir is None:
        return hippo_home
    rel = _sanitize_cwd_subdir(subdir, fixture_name)
    target = hippo_home / rel
    target.mkdir(parents=True, exist_ok=True)
    if not (target / ".hippo" / "hippo.db").exists():
        run_hippo(
            ["init", "--no-learn", "--no-hooks", "--no-schedule"],
            hippo_home,
            cwd=target,
        ).check_returncode()
    return target


def run_hippo(
    args: list[str],
    hippo_home: Path,
    timeout: int = 30,
    extra_env: dict[str, str] | None = None,
    cwd: Path | None = None,
) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HIPPO_HOME"] = str(hippo_home)
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        HIPPO_BIN + args,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=str(cwd if cwd is not None else hippo_home),
    )


@dataclass
class QueryResult:
    query: str
    expected_any: list[str]
    forbidden: list[str]
    matched: str | None
    leaked: str | None
    passed: bool
    top_k_text: list[str]


@dataclass
class FixtureResult:
    name: str
    mechanic: str
    queries: list[QueryResult]
    duration_s: float
    pass_rate: float


# Match the "Remembered [<id>]" line that `hippo remember` prints to stdout.
# IDs are short hex; keeping the regex permissive so we don't depend on length.
import re
_REMEMBER_ID_RE = re.compile(r"Remembered\s+\[([^\]]+)\]")


def _extract_remembered_id(stdout: str) -> str | None:
    m = _REMEMBER_ID_RE.search(stdout)
    return m.group(1) if m else None


def score_fixture(fixture: dict) -> FixtureResult:
    name = fixture["name"]
    mechanic = fixture.get("mechanic", "unknown")
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix=f"hippo-micro-{name}-") as tmp:
        home = Path(tmp)
        # --no-learn blocks both git history seeding and agent MEMORY.md auto-import
        # so each fixture runs against ONLY its declared `remembers`.
        run_hippo(["init", "--no-learn", "--no-hooks", "--no-schedule"], home).check_returncode()
        remember_ids: list[str | None] = []
        remember_cwds: list[Path] = []
        for item in fixture["remembers"]:
            # Item may be a plain string OR an object {"text": "...", "tags": ["foo", "bar"]}
            # for fixtures that need per-memory metadata (e.g. dlPFC goal conditioning).
            if isinstance(item, str):
                text = item
                tags: list[str] = []
                subdir = None
            elif isinstance(item, dict):
                text = item["text"]
                tags = list(item.get("tags") or [])
                subdir = item.get("cwd_subdir")
            else:
                raise ValueError(
                    f"fixture {name!r}: remembers entries must be string or "
                    f"{{text, tags}} object, got {type(item).__name__}"
                )
            cmd = ["remember", text]
            for t in tags:
                cmd.extend(["--tag", t])
            item_cwd = _resolve_item_cwd(home, subdir, name)
            cp = run_hippo(cmd, home, cwd=item_cwd)
            cp.check_returncode()
            remember_ids.append(_extract_remembered_id(cp.stdout))
            remember_cwds.append(item_cwd)

        # Global IDs reminted by a `promote` action, parallel to remember_ids.
        # A recall from a cwd other than the remember's hits the PROMOTED
        # global copy (its retrieval_count moves, not the local original's),
        # so recall-action verification must trace the promoted id when one
        # exists. `hippo trace` resolves g_* ids from any cwd.
        promoted_ids: list[str | None] = [None] * len(remember_ids)

        # Optional action steps (e.g. supersede). Run in declared order.
        for action in fixture.get("actions", []) or []:
            atype = action.get("type")
            if atype == "supersede":
                idx = int(action["remember_index"])
                old_id = remember_ids[idx]
                if old_id is None:
                    raise RuntimeError(
                        f"fixture {name!r}: cannot supersede remember[{idx}] — id not captured"
                    )
                # Run from the remember's own cwd: an id remembered under a
                # cwd_subdir lives in THAT directory's local store.
                run_hippo(
                    ["supersede", old_id, action["new_content"]], home,
                    cwd=remember_cwds[idx],
                ).check_returncode()
            elif atype == "outcomes":
                idx = int(action["remember_index"])
                target_id = remember_ids[idx]
                if target_id is None:
                    raise RuntimeError(
                        f"fixture {name!r}: cannot apply outcomes to remember[{idx}] — id not captured"
                    )
                good_n = int(action.get("good", 0) or 0)
                bad_n = int(action.get("bad", 0) or 0)
                for _ in range(good_n):
                    run_hippo(
                        ["outcome", "--good", "--id", target_id], home,
                        cwd=remember_cwds[idx],
                    ).check_returncode()
                for _ in range(bad_n):
                    run_hippo(
                        ["outcome", "--bad", "--id", target_id], home,
                        cwd=remember_cwds[idx],
                    ).check_returncode()
            elif atype == "recall":
                # Bump retrieval_count by issuing real `hippo recall` calls. The
                # `remember_index` is informational only — `recall` returns the
                # top-K matches for `query`, and any returned memory has its
                # retrieval_count incremented inside markRetrieved (search.ts).
                # `times` controls how many times the query is run.
                query = action.get("query")
                if not query:
                    raise RuntimeError(
                        f"fixture {name!r}: 'recall' action requires 'query'"
                    )
                times = int(action.get("times", 1) or 1)
                # `--limit 1` caps retrieval BEFORE markRetrieved runs in
                # cli.ts, so only the top match has its retrieval_count bumped.
                # The fixture's `query` must be selective enough to put the
                # target memory at rank 1 (typically a unique marker token).
                idx = int(action.get("remember_index", -1))
                action_cwd = _resolve_item_cwd(home, action.get("cwd_subdir"), name)
                recalled_top_id: str | None = None
                for _ in range(times):
                    cp = run_hippo(
                        ["recall", query, "--json", "--budget", "1000", "--limit", "1"],
                        home,
                        cwd=action_cwd,
                    )
                    cp.check_returncode()
                    try:
                        payload = json.loads(cp.stdout) if cp.stdout.strip() else {}
                        results = payload.get("results") or payload.get("memories") or []
                        if results:
                            recalled_top_id = results[0].get("id") or recalled_top_id
                    except json.JSONDecodeError:
                        pass
                # Trace the copy the recall ACTUALLY hit: after a promote, the
                # local copy wins the local-first cross-store dedup at its own
                # cwd while the promoted g_* copy wins from a foreign cwd, and
                # markRetrieved bumps whichever was returned. The returned id
                # must be a copy of the DECLARED target - if the query ranked
                # some other memory first, the action silently strengthened a
                # competitor and the fixture is broken: fail loud.
                declared_ids = (
                    {i for i in (remember_ids[idx], promoted_ids[idx]) if i}
                    if 0 <= idx < len(remember_ids)
                    else set()
                )
                if declared_ids and recalled_top_id and recalled_top_id not in declared_ids:
                    raise RuntimeError(
                        f"fixture {name!r}: recall action returned {recalled_top_id!r}, "
                        f"not a copy of remember[{idx}] (expected one of "
                        f"{sorted(declared_ids)}); the query must rank the target at 1"
                    )
                target_id = recalled_top_id or (
                    (promoted_ids[idx] or remember_ids[idx])
                    if 0 <= idx < len(remember_ids)
                    else None
                )
                # If a target was named, sanity-check retrieval_count actually moved.
                if idx >= 0 and target_id is not None:
                    # Trace from the same cwd the recalls used, so an id whose
                    # local store lives under a cwd_subdir is visible to it.
                    cp = run_hippo(["trace", target_id, "--json"], home, cwd=action_cwd)
                    cp.check_returncode()
                    try:
                        trace = json.loads(cp.stdout)
                        rc = trace.get("retrieval_count", 0)
                        if rc < times:
                            raise RuntimeError(
                                f"fixture {name!r}: recall action did not bump "
                                f"retrieval_count for remember[{idx}] "
                                f"(got {rc}, expected >= {times})"
                            )
                    except json.JSONDecodeError:
                        pass
            elif atype == "promote":
                idx = int(action["remember_index"])
                target_id = remember_ids[idx]
                if target_id is None:
                    raise RuntimeError(
                        f"fixture {name!r}: cannot promote remember[{idx}] — id not captured"
                    )
                cp = run_hippo(
                    ["promote", target_id], home, cwd=remember_cwds[idx]
                )
                cp.check_returncode()
                # Capture the reminted global id ("Promoted mem_x ... as g_y")
                # so later recall-action verification can trace the copy the
                # recall actually hits.
                m = re.search(r"\bas\s+(g_[A-Za-z0-9]+)", cp.stdout)
                if m:
                    promoted_ids[idx] = m.group(1)
            elif atype == "forget":
                idx = int(action["remember_index"])
                target_id = remember_ids[idx]
                if target_id is None:
                    raise RuntimeError(
                        f"fixture {name!r}: cannot forget remember[{idx}] — id not captured"
                    )
                run_hippo(
                    ["forget", target_id], home, cwd=remember_cwds[idx]
                ).check_returncode()
            else:
                raise ValueError(f"fixture {name!r}: unknown action type {atype!r}")

        query_results = []
        for q in fixture["queries"]:
            top_k = q.get("top_k", 5)
            extra = q.get("cli_args", []) or []

            # Per-query pre_actions (B3 dlPFC depth). Currently supports:
            #   goal_push: shell out `hippo goal push <name> --session-id <sid>`
            #              against the same temp HIPPO_HOME, BEFORE the recall
            #              subprocess. Captures the session_id so we can also
            #              thread HIPPO_SESSION_ID into the recall env (the CLI
            #              auto-applies a goal-tag boost when the env var is
            #              set, see src/cli.ts:resolveSessionForRecall).
            # Resolve the query's cwd BEFORE pre-actions so goal_push writes to
            # the SAME local store the recall will read (goals live in the
            # cwd-derived store; a goal pushed at home is invisible to a recall
            # run under a cwd_subdir).
            query_cwd = _resolve_item_cwd(home, q.get("cwd_subdir"), name)
            pre_session_id: str | None = None
            for pa in q.get("pre_actions", []) or []:
                op = pa.get("op")
                if op == "goal_push":
                    goal_name = pa.get("name")
                    sid = pa.get("session_id")
                    if not goal_name or not sid:
                        raise RuntimeError(
                            f"fixture {name!r}: goal_push pre_action requires "
                            f"'name' and 'session_id'"
                        )
                    run_hippo(
                        ["goal", "push", goal_name, "--session-id", sid], home,
                        cwd=query_cwd,
                    ).check_returncode()
                    # First goal_push wins; later ones in the same query keep
                    # the same session unless they override.
                    if pre_session_id is None:
                        pre_session_id = sid
                else:
                    raise ValueError(
                        f"fixture {name!r}: unknown pre_action op {op!r}"
                    )

            # Thread HIPPO_SESSION_ID into the recall subprocess so the CLI's
            # goal-tag boost actually fires. Source priority:
            #   1) explicit --session-id in cli_args (already passed in `extra`)
            #   2) pre_actions session_id
            # The CLI itself prefers --session-id over $HIPPO_SESSION_ID, so
            # setting both is safe and idempotent. See cli.ts:resolveGoalSession
            # / resolveSessionForRecall.
            recall_env: dict[str, str] = {}
            cli_session_id: str | None = None
            for i, tok in enumerate(extra):
                if tok == "--session-id" and i + 1 < len(extra):
                    cli_session_id = extra[i + 1]
                    break
            session_for_env = cli_session_id or pre_session_id
            if session_for_env:
                recall_env["HIPPO_SESSION_ID"] = session_for_env

            cp = run_hippo(
                ["recall", q["q"], "--json", "--budget", "4000", *extra],
                home,
                extra_env=recall_env or None,
                cwd=query_cwd,
            )
            try:
                payload = json.loads(cp.stdout) if cp.stdout.strip() else {}
            except json.JSONDecodeError:
                payload = {}
            memories = payload.get("memories", []) or payload.get("results", []) or []
            texts = [(m.get("text") or m.get("content") or "") for m in memories[:top_k]]
            joined = " || ".join(texts).lower()
            matched = next((s for s in q["must_contain_any"] if s.lower() in joined), None)
            forbidden = q.get("must_not_contain_any", []) or []
            leaked = next((s for s in forbidden if s.lower() in joined), None)
            passed = matched is not None and leaked is None
            query_results.append(QueryResult(
                query=q["q"],
                expected_any=q["must_contain_any"],
                forbidden=list(forbidden),
                matched=matched,
                leaked=leaked,
                passed=passed,
                top_k_text=texts,
            ))

    duration = time.time() - t0
    pass_rate = sum(1 for r in query_results if r.passed) / max(1, len(query_results))
    return FixtureResult(
        name=name,
        mechanic=mechanic,
        queries=query_results,
        duration_s=round(duration, 2),
        pass_rate=round(pass_rate, 3),
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--filter", help="Substring match on fixture name or mechanic")
    ap.add_argument("--baseline", help="Path to baseline results JSON to diff against")
    ap.add_argument("--out", help="Path to write results JSON (default: results/latest.json)")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    fixtures = []
    for path in sorted(FIXTURES_DIR.glob("*.json")):
        with path.open() as f:
            fx = json.load(f)
        if args.filter and args.filter not in fx["name"] and args.filter != fx.get("mechanic"):
            continue
        fixtures.append(fx)

    if not fixtures:
        print("no fixtures found", file=sys.stderr)
        return 2

    results = []
    print(f"running {len(fixtures)} fixtures...")
    for fx in fixtures:
        r = score_fixture(fx)
        results.append(r)
        flag = "PASS" if r.pass_rate == 1.0 else "FAIL"
        print(f"  [{flag}] {r.name:30s} mechanic={r.mechanic:14s} "
              f"pass={r.pass_rate:.2f} ({sum(q.passed for q in r.queries)}/{len(r.queries)}) "
              f"{r.duration_s}s")
        if args.verbose:
            for q in r.queries:
                if not q.passed:
                    reason = "MISS" if q.matched is None else f"LEAKED({q.leaked!r})"
                    print(f"      {reason}  q={q.query!r}  expected_any={q.expected_any}  forbidden={q.forbidden}")
                    for t in q.top_k_text:
                        print(f"            -> {t[:120]}")

    overall = sum(r.pass_rate for r in results) / len(results)
    total_time = sum(r.duration_s for r in results)
    print(f"\noverall pass={overall:.3f}  total={total_time:.1f}s  fixtures={len(results)}")

    out_path = Path(args.out) if args.out else RESULTS_DIR / "latest.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "overall_pass_rate": overall,
        "total_duration_s": total_time,
        "fixtures": [asdict(r) for r in results],
    }
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"wrote {out_path}")

    if args.baseline:
        try:
            base = json.loads(Path(args.baseline).read_text())
            base_by_name = {f["name"]: f["pass_rate"] for f in base["fixtures"]}
            print("\ndelta vs baseline:")
            for r in results:
                b = base_by_name.get(r.name)
                if b is None:
                    print(f"  NEW    {r.name}: {r.pass_rate:.2f}")
                else:
                    delta = r.pass_rate - b
                    sign = "+" if delta > 0 else ("=" if delta == 0 else "-")
                    print(f"  {sign}      {r.name}: {b:.2f} -> {r.pass_rate:.2f} ({delta:+.2f})")
        except Exception as e:
            print(f"baseline diff failed: {e}", file=sys.stderr)

    return 0 if overall == 1.0 else 1


if __name__ == "__main__":
    sys.exit(main())
