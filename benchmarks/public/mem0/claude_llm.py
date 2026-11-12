"""Claude Sonnet 5 through `claude -p` on the Claude subscription: a call function and an OpenAI-compatible proxy.

Every call is logged. A usage limit is waited out, a call that still fails raises, and no reply is ever made up.
Proxy: `python claude_llm.py --work DIR --log calls.jsonl --port 8790 --effort low` serves /v1/chat/completions.
With --judge-log, requests for gpt-5.6-sol go to codex (qa/codex_judge.py) and the rest to `claude -p`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MODEL = "claude-sonnet-5"
# Only what the CLI needs to start and find its login: no CLAUDE_*, ANTHROPIC_* or key variables reach it.
KEEP_ENV = {
    "APPDATA", "COMPUTERNAME", "COMSPEC", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS",
    "OS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
    "PROGRAMW6432", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "TMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR",
}
LIMIT_RE = re.compile(r"usage limit|rate limit|hit your limit|limit reached|resets", re.I)
MAX_FAILURES, MAX_JSON_MISSES = 4, 3
DEADLINE_S = 11 * 3600  # slot waits, runs and retries included, so a call fails inside the 12 h client timeouts


def json_reply(text: str) -> dict | None:
    """The JSON object in a reply, found the way Mem0 finds it: a whole-reply code fence, else the outer braces."""
    t = text.strip()
    fenced = re.match(r"^```[a-zA-Z0-9]*\n([\s\S]*?)\n```$", t)
    for cand in (fenced.group(1) if fenced else t, t[t.find("{"): t.rfind("}") + 1]):
        try:
            obj = json.loads(cand, strict=False)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            return obj
    return None


class ToolUse(RuntimeError):
    """A reply whose run used a tool: logged as an ask that is never valid (prereg Amendment 6 revision 1 item 7)."""

    def __init__(self, rec: dict) -> None:
        super().__init__(f"{rec['tag']}: the reply used a tool: {rec['tools']}")
        self.rec = rec


class Claude:
    def __init__(self, work: Path, log: Path, slots: int) -> None:
        self.exe = shutil.which("claude")
        if not self.exe:
            raise SystemExit("claude CLI not found on PATH")
        self.cwd, self.sysdir = work / "cwd", work / "system-prompts"
        for d in (self.cwd, self.sysdir):
            d.mkdir(parents=True, exist_ok=True)
        self.log_path = log
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(slots)
        self.env = {k: v for k, v in os.environ.items() if k.upper() in KEEP_ENV}
        # Benchmark load goes on the founder's subscription token, never the interactive login (Amendment 6).
        if os.environ.get("BENCH_CLAUDE_OAUTH_TOKEN"):
            self.env["CLAUDE_CODE_OAUTH_TOKEN"] = os.environ["BENCH_CLAUDE_OAUTH_TOKEN"]
        self.env["DISABLE_AUTOUPDATER"] = "1"  # one CLI version for the whole run
        ver = subprocess.run([self.exe, "--version"], capture_output=True, env=self.env, timeout=60)
        self.cli = ver.stdout.decode("utf-8", "replace").strip()  # stamped on every record for the frozen manifest

    def _log(self, rec: dict) -> None:
        rec["ts"] = round(time.time(), 3)
        with self.lock, self.log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _system_file(self, system: str) -> tuple[Path, str]:
        sha = hashlib.sha256(system.encode()).hexdigest()[:16]
        path = self.sysdir / f"{sha}.txt"
        if not path.exists():
            path.write_bytes(system.encode("utf-8"))  # bytes, so Windows never rewrites the newlines
        return path, sha

    def _run(self, sys_file: Path, user: str, effort: str, deadline: float) -> tuple[dict, str] | None:
        """One `claude -p` run, or None if no slot frees up before the deadline."""
        cmd = [self.exe, "-p", "--safe-mode", "--permission-mode", "manual", "--system-prompt-file", str(sys_file),
               "--tools", "", "--model", MODEL, "--effort", effort, "--no-session-persistence", "--output-format", "json"]
        if not self.slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
            return None
        try:
            limit = max(1.0, min(900.0, deadline - time.monotonic()))
            p = subprocess.run(cmd, input=user.encode("utf-8"), capture_output=True, env=self.env, cwd=self.cwd,
                               timeout=limit)
        except subprocess.TimeoutExpired:
            return {"is_error": True, "result": f"timeout after {limit:.0f} s"}, ""
        finally:
            self.slots.release()
        out, err = p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
        try:
            res = json.loads(out)
        except json.JSONDecodeError:
            res = {"is_error": True, "result": out[-300:]}
        if p.returncode != 0:
            res["is_error"] = True
        return res, err[-300:]

    def _fail(self, base: dict, why: str) -> None:
        self._log({**base, "event": "fail", "why": why})
        raise RuntimeError(f"{base['tag']}: {why}")

    def ask(self, system: str, user: str, *, effort: str, tag: str, want_json: bool = False) -> dict:
        sys_file, sys_sha = self._system_file(system)
        base = {"tag": tag, "sys": sys_sha, "user": hashlib.sha256(user.encode()).hexdigest()[:16], "effort": effort,
                "cli": self.cli}
        failures = misses = attempt = waited = 0
        deadline = time.monotonic() + DEADLINE_S
        while True:
            if time.monotonic() >= deadline:
                self._fail(base, f"no reply within {DEADLINE_S} s")
            attempt += 1
            t0 = time.time()
            got = self._run(sys_file, user, effort, deadline)
            if got is None:
                self._fail(base, f"no free slot within {DEADLINE_S} s")
            res, err = got
            text = res.get("result") or ""
            base.update(attempt=attempt, wall_ms=int((time.time() - t0) * 1000))
            if res.get("is_error") or not text.strip():
                detail = f"{res.get('api_error_status')} {text} {err}"[:400]
                if res.get("api_error_status") == 429 or LIMIT_RE.search(detail):
                    delay = 60 if waited == 0 else 300
                    if time.monotonic() + delay > deadline:
                        self._fail(base, f"usage limit not lifted after {waited} s: {detail}")
                    self._log({**base, "event": "limit-wait", "delay_s": delay, "detail": detail})
                    time.sleep(delay)
                    waited += delay
                    continue
                failures += 1
                self._log({**base, "event": "error", "detail": detail})
                if failures >= MAX_FAILURES:
                    self._fail(base, f"{failures} failed attempts: {detail}")
                time.sleep(min(10 * failures, max(0.0, deadline - time.monotonic())))
                continue
            if res.get("tools"):  # only codex_judge reports tools; the caller counts the ask and may ask again
                rec = {**base, "event": "tool-use", "tools": res["tools"], "models": sorted(res.get("modelUsage") or {}),
                       "usage": res.get("usage"), "text": text}
                self._log(rec)
                raise ToolUse(rec)
            if want_json and json_reply(text) is None:
                misses += 1
                self._log({**base, "event": "json-miss", "text": text[:2000]})
                if misses >= MAX_JSON_MISSES:
                    self._fail(base, f"no JSON object in {misses} replies")
                continue
            rec = {**base, "event": "ok", "models": sorted(res.get("modelUsage") or {}), "usage": res.get("usage"),
                   "cost_usd_list": res.get("total_cost_usd"), "api_ms": res.get("duration_api_ms"),
                   "waited_s": waited, "text": text}
            self._log(rec)
            return rec


def serve(claude: Claude, port: int, effort: str, judge: Claude | None = None, tag: str = "extract",
          answer_model: str | None = None, judge_effort: str = "medium") -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def _send(self, code: int, obj: dict) -> None:
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if not self.path.rstrip("/").endswith("/chat/completions"):
                return self._send(404, {"error": {"message": f"no route {self.path}"}})
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
            msgs = req.get("messages") or []
            system = "\n\n".join(m["content"] for m in msgs if m.get("role") == "system")
            rest = [m for m in msgs if m.get("role") != "system"]
            if len(rest) != 1 or rest[0].get("role") != "user" or not isinstance(rest[0].get("content"), str):
                return self._send(400, {"error": {"message": "expected system messages and one text user message"}})
            want_json = (req.get("response_format") or {}).get("type") == "json_object"
            model = req.get("model", MODEL)
            llm, kw = (judge, {"effort": judge_effort, "tag": "judge"}) if judge and model == judge.model else (
                claude, {"effort": effort, "tag": tag})
            if llm is claude and answer_model and model != answer_model:
                return self._send(400, {"error": {"message": f"model {model} is neither {answer_model} nor the judge"}})
            try:
                r = llm.ask(system, rest[0]["content"], want_json=want_json, **kw)
            except RuntimeError as e:
                return self._send(502, {"error": {"message": str(e)}})
            u = r.get("usage") or {}
            p_tok = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
            c_tok = u.get("output_tokens") or 0
            self._send(200, {
                "id": f"chatcmpl-{r['user']}", "object": "chat.completion", "created": int(time.time()),
                "model": req.get("model", MODEL),
                "choices": [{"index": 0, "message": {"role": "assistant", "content": r["text"]}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": p_tok, "completion_tokens": c_tok, "total_tokens": p_tok + c_tok},
            })

    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--work", type=Path, required=True, help="scratch dir: the CLI's empty cwd and system prompts")
    ap.add_argument("--log", type=Path, required=True, help="JSONL call log")
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--slots", type=int, default=10, help="concurrent claude processes")
    ap.add_argument("--effort", default="low")
    ap.add_argument("--tag", default="extract", help="call-log tag of the claude route")
    ap.add_argument("--answer-model", help="the only model name the claude route accepts (default: any)")
    ap.add_argument("--judge-log", type=Path, help="JSONL call log of the codex judge; enables the gpt-5.6-sol route")
    ap.add_argument("--judge-slots", type=int, help="concurrent codex processes (default: codex_judge's)")
    a = ap.parse_args()
    judge = None
    if a.judge_log:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "qa"))
        from codex_judge import DEFAULT_SLOTS, CodexJudge
        judge = CodexJudge(a.judge_log, a.judge_slots or DEFAULT_SLOTS)
    serve(Claude(a.work, a.log, a.slots), a.port, a.effort, judge, a.tag, a.answer_model)


if __name__ == "__main__":
    main()
