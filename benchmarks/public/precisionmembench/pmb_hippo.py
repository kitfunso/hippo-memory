"""PrecisionMemBench (arXiv 2605.11325) through its own external-provider harness, over hippo's retrieval
(docs/evals/notes-2026-11-17-precisionmembench.md).

tenurehq/precisionMemBench 61a712a1, run unchanged from a checkout of that commit: the README's two ava commands, the
single-turn eval with RESEED=true and then the session eval, against a `hippo` entry in providers.config.json. The
provider is the README's three-call contract (POST /add, POST /search, DELETE /reset) over one hippo-mem0-server on a
scratch data dir: each /add stores the harness's text as one memory and keeps metadata.beliefId by the memory's id;
/search returns hippo's top `limit` (20, DEFAULT_BUDGET.maxBeliefs) as beliefIds, first hit per belief, as the mem0
wrapper does. No answer model and no judge: the harness scores returned ids. No competitor arm runs.
Usage (runner venv): python -I pmb_hippo.py {run,score} [--arm hippo-emb|bm25] [--smoke] [--port-base 9791]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from statistics import mean

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE.parent)]
from qa.harness import Server, sha_bytes  # noqa: E402
from qa.ledger import one_writer, smoke_excluded  # noqa: E402
from qa.vendor_pin import check  # noqa: E402
from server_arms import fallback_logs  # noqa: E402

NAME = "PrecisionMemBench"
CLONE = Path.home() / "hippo-bench" / "vendor" / "precisionMemBench"
COMMIT = "61a712a1754e7d27b6dee42da32a2c214b003ece"
BLOBS = {  # git ls-tree at COMMIT
    "fixtures/beliefs.seed.json": "2d9c9daf55c075f0f64a9a9f71db61feda7ad4c2",
    "fixtures/retrieval.cases.json": "dd0ee63d91b9b19f4c891463ab104bb2ec0485bd",
    "fixtures/session-retrieval.cases.json": "86c0895b252e8c4722c5d1659071af2649a5b6c3",
    "package-lock.json": "f0b2074a2b44e7a3afbc391137ec8527af31ddbf",
    "package.json": "68121ca3c8a9457ea2f793ac2c7d754e7ec30775",
    "src/adapters/baseAdapter.ts": "74a4f304f9491d9505959fc400a5917ce7b1d741",
    "src/adapters/universalSessionAdapter.ts": "6618db5e37c0b43aadb5dc1f035c5c4ffb105f68",
    "src/retrieval.external.eval.test.ts": "d8bd8acaaa0069f3a6e5e535f84f3d4b3d62206d",
    "src/session-retrieval.external.eval.test.ts": "37e6dfe8e16752db12e8c5b51ba24d7c8a18d8b9",
    "src/types/belief.ts": "d963b123d41574fe797ff23f0c2434676a622635",
    "src/utils/buildRetrievalReport.ts": "f3b875c9c91e450df4391f29c36a98e0523816c4",
    "src/utils/runProvenance.ts": "e02ee4b35584c93c6dd8ede618c4575925dc999a",
    "tsconfig.json": "b649f6eb66517550dc2f1f7f3b1c67501cb1658c",
}
CONFIG_BLOB = "7ea1d494447548eac535ad8c1aaaeeac95d4dedc"  # providers.config.json, which gains only the hippo entry
# the README's registration shape; 200 ms between seeds is the shortest a shipped entry uses (yourmemory), and hippo
# indexes before /add returns; no /update route, so a session alias update re-adds, as the mem0 and zep entries do
ENTRY = {"envVar": "HIPPO_URL", "defaultUrl": "http://localhost:8090", "seedDelayMs": 200,
         "beliefToText": "canonical_name_aliases", "supportsUpdate": False}
OUT = Path.home() / "hippo-bench" / "results-r2" / "precisionmembench"
HARNESS = OUT / "harness"
ACTIVE_CASES = 43  # "43 active, 25 structural, and 9 trivially empty cases" (paper, Evaluation; README "x/43")
SMOKE = ("happy-stack-repository-layer", "canonical-name-match-mara", "cap-stress-kitchen-sink-exceeds-twelve",
         "recency-tiebreak-reinforcement", "relation-does-not-appear-as-entity")  # cases 0, 19, 38, 57, 76
REPORTS = {"single": "retrieval-report-{}.json", "session": "session-retrieval-report-{}.json"}


class Provider:
    """The three-call contract over one hippo server; beliefIds kept by hippo memory id, every call logged."""

    def __init__(self, srv: Server, log: Path) -> None:
        self.srv, self.log, self.lock = srv, log, threading.Lock()
        self.belief_of: dict[str, str] = {}
        self.users: set[str] = set()

    def note(self, rec: dict) -> None:
        with self.log.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def add(self, body: dict) -> dict:
        belief, user = (body.get("metadata") or {})["beliefId"], body["user_id"]
        with self.lock:
            res = self.srv.call("POST", "/memories", {"messages": [{"role": "user", "content": body["text"]}],
                                                      "user_id": user})["results"]
            self.belief_of.update({r["id"]: belief for r in res})
            self.users.add(user)
            self.note({"op": "add", "user": user, "beliefId": belief, "ids": [r["id"] for r in res]})
        return {"ok": True}

    def search(self, body: dict) -> dict:
        with self.lock:
            res = self.srv.call("POST", "/search", {"query": body["query"], "user_id": body["user_id"],
                                                    "limit": body.get("limit") or 20})["results"]
            out, seen = [], set()
            for r in res:
                belief = self.belief_of[r["id"]]
                if belief not in seen:
                    seen.add(belief)
                    out.append({"id": belief, "memory": r["memory"], "score": r["score"]})
            self.note({"op": "search", "user": body["user_id"], "query": body["query"], "limit": body.get("limit"),
                       "scope": body.get("scope"), "hits": len(res), "ids": [o["id"] for o in out]})
        return {"results": out}

    def reset(self) -> dict:
        with self.lock:
            for user in sorted(self.users):
                self.srv.delete(user)
            self.belief_of.clear()
            self.users.clear()
            self.note({"op": "reset"})
        return {"ok": True}


def handler(p: Provider):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, code: int, body: dict) -> None:
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def route(self, routes: dict) -> None:
            fn = routes.get(self.path)
            if fn is None:
                return self.reply(404, {"error": f"{self.command} {self.path} is not part of the contract"})
            n = int(self.headers.get("Content-Length") or 0)
            try:
                self.reply(200, fn(json.loads(self.rfile.read(n) or b"{}")))
            except Exception as e:  # the harness only sees a 500; the log keeps the cause
                p.note({"op": "error", "path": self.path, "error": repr(e)})
                self.reply(500, {"error": repr(e)})

        def do_POST(self) -> None:  # noqa: N802
            self.route({"/add": p.add, "/search": p.search})

        def do_DELETE(self) -> None:  # noqa: N802
            self.route({"/reset": lambda _: p.reset()})

        def log_message(self, *a) -> None:
            pass
    return Handler


def harness_checkout() -> Path:
    """A checkout of COMMIT beside the results with the hippo entry registered; the clone itself stays pristine."""
    check(CLONE, COMMIT, BLOBS)
    if not (HARNESS / ".git").exists():
        subprocess.run(["git", "clone", "-q", "--no-checkout", str(CLONE), str(HARNESS)], check=True)
        subprocess.run(["git", "-C", str(HARNESS), "config", "core.autocrlf", "false"], check=True)
        subprocess.run(["git", "-C", str(HARNESS), "checkout", "-q", "--detach", COMMIT], check=True)
    check(HARNESS, COMMIT, BLOBS)
    pinned = subprocess.run(["git", "-C", str(HARNESS), "cat-file", "-p", CONFIG_BLOB], capture_output=True,
                            check=True).stdout
    (HARNESS / "providers.config.json").write_text(json.dumps({**json.loads(pinned), "hippo": ENTRY}, indent=2) + "\n",
                                                   encoding="utf-8")
    if not (HARNESS / "node_modules" / "ava").exists():
        subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "ci", "--no-audit", "--no-fund"], cwd=HARNESS,
                       check=True)
    return HARNESS


def ava(test: str, url: str, reseed: bool, match: tuple[str, ...], log: Path) -> Path:
    """One README command; ava exits non-zero when any case fails, so the fresh report is the check."""
    report = HARNESS / "test-results" / REPORTS[test].format("hippo")
    report.unlink(missing_ok=True)
    env = {**os.environ, "MEMORY_PROVIDER": "hippo", "HIPPO_URL": url, "RESEED": "true" if reseed else "false",
           "FORCE_COLOR": "0"}
    if os.name == "nt":
        env["NODE_OPTIONS"] = f"--import={(HERE / 'winpath.mjs').as_uri()}"
    src = {"single": "src/retrieval.external.eval.test.ts", "session": "src/session-retrieval.external.eval.test.ts"}
    cmd = [shutil.which("node"), "node_modules/ava/entrypoints/cli.js", src[test], "--timeout", "10m",
           *[x for c in match for x in ("--match", f"*{c}:*")]]
    with log.open("ab") as f:
        rc = subprocess.run(cmd, cwd=HARNESS, env=env, stdout=f, stderr=f).returncode
    if not report.exists():
        sys.exit(f"ava {test} exited {rc} with no report; see {log}")
    return report


def run(out: Path, arm: str, smoke: bool, port: int) -> None:
    harness_checkout()
    (out / "provider.jsonl").unlink(missing_ok=True)
    with Server(arm, port + 1, out / "data", out / "server.log") as srv:
        p = Provider(srv, out / "provider.jsonl")
        http = ThreadingHTTPServer(("127.0.0.1", port), handler(p))
        threading.Thread(target=http.serve_forever, daemon=True).start()
        try:
            url = f"http://127.0.0.1:{port}"
            tests = [("single", True, SMOKE if smoke else ())] + ([] if smoke else [("session", False, ())])
            for test, reseed, match in tests:
                t0 = time.time()
                report = ava(test, url, reseed, match, out / "ava.log")
                shutil.copyfile(report, out / report.name)
                print(f"{test}: report in {time.time() - t0:.0f}s", flush=True)
            (out / "health.json").write_text(json.dumps(srv.health), encoding="utf-8")
        finally:
            http.shutdown()
    if bad := fallback_logs([out / "server.log"]):
        sys.exit(f"a search ran on BM25 alone: hippo logged 'fell back' in {bad[0]}")
    cfg = {"lane": "precisionmembench, notes-2026-11-17-precisionmembench.md", "arm": arm, "smoke": smoke,
           "commit": COMMIT, "blobs": BLOBS, "provider_entry": ENTRY,
           "hippo_memory": json.loads((HERE.parents[2] / "package.json").read_text(encoding="utf-8"))["version"],
           "repo_head": subprocess.run(["git", "-C", str(HERE.parents[2]), "rev-parse", "HEAD"], capture_output=True,
                                       text=True, check=True).stdout.strip(),
           "script_sha256": sha_bytes(Path(__file__).read_bytes())}
    (out / "config.json").write_text(json.dumps(cfg, indent=1), encoding="utf-8")


def single_line(name: str, rep: dict, ids: set[str] | None = None) -> str:
    """The README's single-turn row from a report: active passes of 43, passes, mean precision and recall, p50,
    ingestion total; over `ids` the passes and means are recomputed from the cases."""
    r, cases = rep["retrieval"], [c for c in rep["cases"] if ids is None or c["caseId"] in ids]
    prec = [c["retrievalPrecision"] for c in cases if c["retrievalPrecision"] is not None]
    rec = [c["retrievalRecall"] for c in cases if c["retrievalRecall"] is not None]
    ing = (rep.get("ingestion") or {}).get("totalMs")
    return (f"{name:<22} active {r['activeRetrievalPasses'] if ids is None else '-':>2}/{ACTIVE_CASES}  passes "
            f"{sum(c['passed'] for c in cases):>2}/{len(cases)}  precision {mean(prec):.4f}  recall {mean(rec):.4f}  "
            f"p50 {r['p50LatencyMs']:.2f} ms  ingestion {'-' if ing is None else f'{ing / 1000:.1f} s'}  "
            f"types {r['passTypes']}")


def session_line(name: str, rep: dict) -> str:
    r, cases = rep["retrieval"], rep["cases"]
    return (f"{name:<22} turns passed {r['totalPassed']:>2}/{r['totalCases']}  drift "
            f"{mean(c['driftScore'] for c in cases):.4f}  precision {r['meanPrecision']}  p50 {r['p50LatencyMs']:.2f} ms")


def score(out: Path, arm: str, smoke: bool) -> None:
    single = json.loads((out / REPORTS["single"].format("hippo")).read_text(encoding="utf-8"))
    if smoke:
        lines = [f"SMOKE {NAME}, {arm}: integrity only, never scored or read",
                 f"cases {len(single['cases'])}: {', '.join(c['caseId'] for c in single['cases'])}",
                 f"seeded {single['ingestion']['beliefCount']} beliefs; every case has a report entry"]
    else:
        session = json.loads((out / REPORTS["session"].format("hippo")).read_text(encoding="utf-8"))
        every = [c["caseId"] for c in single["cases"]] + [f"{c['caseId']}#{c['turnIndex']}" for c in session["cases"]]
        primary = set(every) - smoke_excluded("precisionmembench", every)
        lines = [f"{NAME} via its harness ({COMMIT[:8]}), {arm}: limit 20, beliefToText canonical_name_aliases",
                 "single-turn, all items:", single_line("hippo", single), "single-turn, primary (smoke cases out):",
                 single_line("hippo", single, primary), "session, all 12 turns:", session_line("hippo", session),
                 "", f"published rows, recomputed by these functions from the reports at {COMMIT[:8]}:"]
        base = CLONE / "test-results" / "baseline"
        for p in sorted(base.glob("retrieval-report-*.json")):
            name = p.name.removeprefix("retrieval-report-").removesuffix(".json")
            lines.append(single_line(name, json.loads(p.read_text(encoding="utf-8"))))
            if (s := base / REPORTS["session"].format(name)).exists():
                lines.append(session_line(name, json.loads(s.read_text(encoding="utf-8"))))
    (out / ("smoke.txt" if smoke else "score.txt")).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("stage", choices=("run", "score"))
    ap.add_argument("--arm", choices=("hippo-emb", "bm25"), default="hippo-emb")
    ap.add_argument("--smoke", action="store_true", help=f"single-turn cases {SMOKE} only")
    ap.add_argument("--port-base", type=int, default=9791, help="the provider; its hippo server takes the next port")
    a = ap.parse_args()
    out = (OUT / "smoke" if a.smoke else OUT) / a.arm
    if a.stage == "score":
        return score(out, a.arm, a.smoke)
    with one_writer(out):
        run(out, a.arm, a.smoke, a.port_base)


if __name__ == "__main__":
    main()
