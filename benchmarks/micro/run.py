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
      "Alice prefers green tea"
    ],
    "queries": [
      {"q": "what does Bob drink",
       "must_contain_any": ["oat milk", "latte"],   # at least one substring in top-k recall
       "top_k": 3}
    ]
  }

Usage:
  python benchmarks/micro/run.py
  python benchmarks/micro/run.py --filter decay
  python benchmarks/micro/run.py --baseline results/baseline.json   # diff vs baseline

Pass criterion: every query's top-k results must contain at least one
substring from must_contain_any (case-insensitive).
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
    matched: str | None
    passed: bool
    top_k_text: list[str]


@dataclass
class FixtureResult:
    name: str
    mechanic: str
    queries: list[QueryResult]
    duration_s: float
    pass_rate: float


def score_fixture(fixture: dict) -> FixtureResult:
    name = fixture["name"]
    mechanic = fixture.get("mechanic", "unknown")
    t0 = time.time()
    with tempfile.TemporaryDirectory(prefix=f"hippo-micro-{name}-") as tmp:
        home = Path(tmp)
        # --no-learn blocks both git history seeding and agent MEMORY.md auto-import
        # so each fixture runs against ONLY its declared `remembers`.
        run_hippo(["init", "--no-learn", "--no-hooks", "--no-schedule"], home).check_returncode()
        for text in fixture["remembers"]:
            run_hippo(["remember", text], home).check_returncode()

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
            query_results.append(QueryResult(
                query=q["q"],
                expected_any=q["must_contain_any"],
                matched=matched,
                passed=matched is not None,
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
                    print(f"      MISS  q={q.query!r}  expected_any={q.expected_any}")
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
