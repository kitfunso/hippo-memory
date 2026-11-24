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
    env_bin = os.environ.get("HIPPO_BIN")
    if env_bin:
        return env_bin.split()

    default = "hippo"
    resolved = shutil.which(default)
    is_shim = resolved is not None and Path(resolved).suffix.lower() in (".cmd", ".bat")
    if resolved is None or is_shim:
        repo_root = ROOT.parent.parent
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
    env["HOME"] = str(hippo_home)
    env["USERPROFILE"] = str(hippo_home)
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


FALLBACK_WARNING = "cross-encoder reranker unavailable"


def preflight_embeddings() -> None:
    with tempfile.TemporaryDirectory(prefix="hippo-micro-preflight-") as tmp:
        home = Path(tmp)
        run_hippo(["init", "--no-learn", "--no-hooks", "--no-schedule"], home).check_returncode()
        run_hippo(["remember", "preflight embedding probe"], home, timeout=300).check_returncode()
        r = run_hippo(["recall", "embedding probe", "--json", "--why", "--reranker", "cross-encoder"], home, timeout=300)
    r.check_returncode()
    rows = json.loads(r.stdout)["results"]
    cosine = rows[0].get("cosine") if rows else None
    problems = []
    if not isinstance(cosine, (int, float)) or cosine <= 0:
        problems.append(f"the probe row has cosine {cosine!r}, so no embedding was computed")
    if FALLBACK_WARNING in r.stderr:
        problems.append("the cross-encoder fell back to identity ordering")
    if problems:
        sys.exit(
            "micro-eval needs the Transformers.js backend with loadable weights: " + "; ".join(problems)
            + ". Install it into this checkout (not saved to package.json): npm install --no-save @huggingface/transformers"
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
        run_hippo(["init", "--no-learn", "--no-hooks", "--no-schedule"], home).check_returncode()
        remember_ids: list[str | None] = []
        remember_cwds: list[Path] = []
        remember_texts: list[str] = []
        for item in fixture["remembers"]:
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
            remember_texts.append(text)

        # Global IDs reminted by a `promote` action, parallel to remember_ids.
        # global copy (its retrieval_count moves, not the local original's),
        promoted_ids: list[str | None] = [None] * len(remember_ids)

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
                query = action.get("query")
                if not query:
                    raise RuntimeError(
                        f"fixture {name!r}: 'recall' action requires 'query'"
                    )
                times = int(action.get("times", 1) or 1)
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
                if idx >= 0 and target_id is not None:
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
            elif atype == "reject":
                idx = int(action["remember_index"])
                target_id = remember_ids[idx]
                if target_id is None:
                    raise RuntimeError(
                        f"fixture {name!r}: cannot reject remember[{idx}]: id not captured"
                    )
                reason = action.get("reason")
                if not reason:
                    raise ValueError(f"fixture {name!r}: reject action needs a non-empty 'reason'")
                run_hippo(
                    ["reject", target_id, "--reason", reason], home, cwd=remember_cwds[idx]
                ).check_returncode()
                if action.get("reattempt", False):
                    cp = run_hippo(["remember", remember_texts[idx]], home, cwd=remember_cwds[idx])
                    if cp.returncode == 0 or "rejected value" not in cp.stderr:
                        raise RuntimeError(
                            f"fixture {name!r}: re-remember of rejected remember[{idx}] was not "
                            f"refused (rc={cp.returncode}); stdout={cp.stdout!r} stderr={cp.stderr!r}"
                        )
            else:
                raise ValueError(f"fixture {name!r}: unknown action type {atype!r}")

        query_results = []
        for q in fixture["queries"]:
            top_k = q.get("top_k", 5)
            extra = q.get("cli_args", []) or []

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
                    if pre_session_id is None:
                        pre_session_id = sid
                else:
                    raise ValueError(
                        f"fixture {name!r}: unknown pre_action op {op!r}"
                    )

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

    preflight_embeddings()
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
