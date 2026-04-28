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
      {"text": "...", "tags": ["auth-rewrite"]}   # object form attaches --tag flags
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
       "cli_args": ["--include-superseded"]}
    ]
  }

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
               rather than lexical overlap. Example:
                 {"type": "recall", "query": "marker-pineal-1",
                  "remember_index": 0, "times": 3}

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
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FIXTURES_DIR = ROOT / "fixtures"
RESULTS_DIR = ROOT / "results"
HIPPO_BIN = os.environ.get("HIPPO_BIN", "hippo").split()


def run_hippo(args: list[str], hippo_home: Path, timeout: int = 30) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["HIPPO_HOME"] = str(hippo_home)
    return subprocess.run(
        HIPPO_BIN + args,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=str(hippo_home),
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
        for item in fixture["remembers"]:
            # Item may be a plain string OR an object {"text": "...", "tags": ["foo", "bar"]}
            # for fixtures that need per-memory metadata (e.g. dlPFC goal conditioning).
            if isinstance(item, str):
                text = item
                tags: list[str] = []
            elif isinstance(item, dict):
                text = item["text"]
                tags = list(item.get("tags") or [])
            else:
                raise ValueError(
                    f"fixture {name!r}: remembers entries must be string or "
                    f"{{text, tags}} object, got {type(item).__name__}"
                )
            cmd = ["remember", text]
            for t in tags:
                cmd.extend(["--tag", t])
            cp = run_hippo(cmd, home)
            cp.check_returncode()
            remember_ids.append(_extract_remembered_id(cp.stdout))

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
                run_hippo(
                    ["supersede", old_id, action["new_content"]], home
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
                    run_hippo(["outcome", "--good", "--id", target_id], home).check_returncode()
                for _ in range(bad_n):
                    run_hippo(["outcome", "--bad", "--id", target_id], home).check_returncode()
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
                target_id = remember_ids[idx] if 0 <= idx < len(remember_ids) else None
                for _ in range(times):
                    run_hippo(
                        ["recall", query, "--json", "--budget", "1000", "--limit", "1"],
                        home,
                    ).check_returncode()
                # If a target was named, sanity-check retrieval_count actually moved.
                if target_id is not None:
                    cp = run_hippo(["trace", target_id, "--json"], home)
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
            else:
                raise ValueError(f"fixture {name!r}: unknown action type {atype!r}")

        query_results = []
        for q in fixture["queries"]:
            top_k = q.get("top_k", 5)
            extra = q.get("cli_args", []) or []
            cp = run_hippo(["recall", q["q"], "--json", "--budget", "4000", *extra], home)
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
