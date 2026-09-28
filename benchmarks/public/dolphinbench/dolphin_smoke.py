"""Zero-model DolphinBench plumbing check, run in WSL: a scripted agent answers one Morgan test
through the real mock apps, and the stock grader calls a local OpenAI-compatible judge.
Usage: python dolphin_smoke.py [stub|codex]   (codex needs DOLPHIN_CODEX_HOME, a clean profile)"""
import asyncio
import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

HERE = Path(__file__).resolve().parent
# The benchmark clone, its venv and every output live in hippo-bench, beside this checkout, never inside it.
BENCH = HERE.parents[3] / "hippo-bench"
ROOT = BENCH / "dolphinbench"
JUDGE = sys.argv[1] if len(sys.argv) > 1 else "stub"
PORT = 18765
MODEL = os.environ.get("DOLPHIN_JUDGE_MODEL", "gpt-6-astra")
# The grader reads these at import time, so they must be set before any harness import.
os.environ.update({
    "DOLPHINBENCH_JUDGE_BACKEND": "openai",
    "DOLPHINBENCH_JUDGE_ENDPOINT": f"http://127.0.0.1:{PORT}/v1/chat/completions",
    "DOLPHINBENCH_JUDGE_MODEL": f"{JUDGE}:{MODEL}" if JUDGE == "codex" else "stub",
    "DOLPHINBENCH_JUDGE_KEY_ENV": "LOCAL_JUDGE_TOKEN",
    "LOCAL_JUDGE_TOKEN": "local-proxy-no-secret",
})
sys.path.insert(0, str(ROOT))
from examples.mcp_connection import connect_apps  # noqa: E402
from harness.adapter import InteractionRecord  # noqa: E402
from harness.runner import Runner  # noqa: E402
from harness.submission import read_release  # noqa: E402

CODEX_JS = r"C:\Users\skf_s\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js"
PREAMBLE = ("You are a JSON-only grading function. Do NOT use any tool. Do NOT read, open, view or write any "
            "file. Everything you need is in this message. Reply with the JSON object only.\n\n")
ORDER = {"restaurant": "Blue Bottle Coffee", "items": ["small latte"], "notes": "pickup"}
SETTINGS = {"model": "scripted-stub-agent"}
USAGE = {"input_tokens": 0, "output_tokens": 0}
JUDGE_LOG: list[dict] = []
# One verdict at a time: parallel codex runs would share one auth refresh.
JUDGE_LOCK = threading.Lock()


def win(path: Path) -> str:
    return subprocess.run(["wslpath", "-w", str(path)], capture_output=True, text=True, check=True).stdout.strip()


def codex_verdict(system: str, user: str, work: Path, tag: str) -> str:
    """One judge call through the Windows codex CLI (ChatGPT plan) via WSL interop."""
    out, log = work / f"codex-{tag}.txt", work / f"codex-{tag}.log"
    out.unlink(missing_ok=True)  # a codex exit 0 without output must fail, never reread an older verdict
    cmd = ["node.exe", CODEX_JS, "exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config",
           "-s", "read-only", "-c", "notify=[]", "-c", 'model_reasoning_effort="medium"', "-m", MODEL,
           "-o", win(out), "-"]
    env = {**os.environ, "CODEX_HOME": os.environ["DOLPHIN_CODEX_HOME"], "WSLENV": "CODEX_HOME/p"}
    with log.open("w") as stream:
        subprocess.run(cmd, input=PREAMBLE + system + "\n\n" + user, text=True, stdout=stream,
                       stderr=subprocess.STDOUT, env=env, cwd=work, timeout=300, check=True)
    return out.read_text().strip()


def serve_judge(work: Path) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            system, user = (m["content"] for m in body["messages"])
            # The arm names its arm, persona and test in ?tag=; the uuid keeps retries and later runs apart.
            label = parse_qs(urlsplit(self.path).query).get("tag", ["untagged"])[0]
            tag = f"{re.sub(r'[^A-Za-z0-9_-]', '_', label)[:80]}-{uuid.uuid4().hex[:8]}"
            with JUDGE_LOCK:
                started = time.monotonic()
                if JUDGE == "codex":
                    text = codex_verdict(system, user, work, tag)
                else:  # SHORTCUT: v1 field judge only, add a v2 {"results": [...]} branch for Riley
                    value = user.split("\n\n")[0]
                    text = json.dumps({"passed": "blue bottle" in value.lower(), "reason": "stub substring rule"})
                JUDGE_LOG.append({"tag": tag, "seconds": round(time.monotonic() - started, 1), "reply": text})
            reply = json.dumps({"choices": [{"index": 0, "message": {"role": "assistant", "content": text}}],
                                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(reply.encode())

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class ScriptedAgent:
    """Stands in for Claude Code: acknowledges history, then places the order the test asks for."""

    def identity(self):
        return {"scripted_agent": "dolphin_smoke", "version": 1}

    def total_cost_usd(self, phase):
        return 0.0

    def freeze(self, persona):
        return {"scripted_agent": True, "persona": persona}

    def verify_checkpoint(self, persona, checkpoint):
        if checkpoint != self.freeze(persona):
            raise ValueError("checkpoint changed")

    def run_interaction(self, request):
        user = {"role": "user", "content": request.dated_message}
        if request.phase == "ingestion":
            return InteractionRecord(SETTINGS, [user, {"role": "assistant", "content": "Noted.", "usage": USAGE}])
        result = asyncio.run(self._order(request.apps))
        call = {"id": "call_1", "name": "mcp__dolphinbench_apps__place_order", "arguments": ORDER}
        return InteractionRecord(SETTINGS, [
            user,
            {"role": "assistant", "content": "", "tool_calls": [call], "usage": USAGE},
            {"role": "tool", "tool_call_id": "call_1", "content": result},
            {"role": "assistant", "content": "Ordered one small latte from Blue Bottle.", "usage": USAGE},
        ])

    async def _order(self, apps):
        async with connect_apps(apps) as session:
            names = [tool.name for tool in (await session.list_tools()).tools]
            if "place_order" not in names:
                raise ValueError(f"place_order not exposed: {names}")
            return (await session.call_tool("place_order", ORDER)).content[0].text


def main() -> None:
    out = BENCH / "runs" / f"smoke-{JUDGE}-{time.strftime('%Y%m%dT%H%M%S')}"
    full = read_release(ROOT)
    morgan = full["morgan"]
    release = {"morgan": {**morgan, "sessions": morgan["sessions"][:2],
                          "tests": [t for t in morgan["tests"] if t["id"] == "001"]}}
    server = serve_judge(out.parent)
    runner = Runner(release, out, ScriptedAgent(), identity={"smoke": JUDGE}, release_root=ROOT)
    runner.allow_paid = True  # skips the replay-only guard so the grader reaches the local judge
    runner.ingest()
    runner.evaluate()
    server.shutdown()
    grade = json.loads((out / "grades/morgan/001.json").read_text())
    print(json.dumps({"out": str(out), "release_personas": sorted(full), "grade": grade,
                      "judge_calls": JUDGE_LOG}, indent=1)[:4000])


if __name__ == "__main__":
    main()
