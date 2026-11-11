"""gpt-5.6-sol at medium effort through `codex exec` on the ChatGPT plan: the judge of prereg Amendment 6.

Every call runs in one shared clean CODEX_HOME that starts with only a copy of the login, with no tools, so no
AGENTS.md, skills, hooks or MCP servers reach the judge. Calls are logged in claude_llm's record shape, so
h2h.verdicts_on_file reads the log; limits are waited out and a failed call raises, never a verdict.
Login safety: refresh tokens are single use, so the pool home never refreshes. Its access token must outlive a
call; near expiry the pool pauses, the main home refreshes as codex does for the user, and the pool copies it in.
Usage: CodexJudge(log=Path("calls-judge.jsonl"), slots=8).ask(system, prompt, tag="judge q1")["text"]
"""
from __future__ import annotations

import base64
import contextlib
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mem0"))
from claude_llm import KEEP_ENV, Claude  # noqa: E402

MODEL = "gpt-5.6-sol"
DEFAULT_SLOTS = 8  # 69.7 calls/min with no errors in the 11 Nov smoke; 4 slots gave 35.5, 1 gave 11.7
CODEX_JS = Path(os.environ.get("APPDATA", "")) / "npm/node_modules/@openai/codex/bin/codex.js"
MAIN_HOME = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
POOL_HOME = Path.home() / "hippo-bench" / ".codex-judge-home"  # outside %TEMP%: codex warns about helper binaries there
# The no-tools preamble of dolphinbench/dolphin_smoke.py:39-40; it cannot be imported, that module boots a harness.
PREAMBLE = ("You are a JSON-only grading function. Do NOT use any tool. Do NOT read, open, view or write any "
            "file. Everything you need is in this message. Reply with the JSON object only.\n\n")
# Account-side features that would add tools, connectors or skills to a clean home; checked by `codex features list`.
OFF = ("apps", "plugins", "remote_plugin", "hooks", "multi_agent", "image_generation", "browser_use",
       "browser_use_external", "computer_use", "in_app_browser", "goals", "tool_suggest", "skill_search",
       "skill_mcp_dependency_install", "shell_tool", "unified_exec", "view_image", "sleep_tool", "code_mode_host")
FLAGS = ("exec", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only",
         "-c", "notify=[]", "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
         "-c", 'web_search="disabled"', *(x for f in OFF for x in ("--disable", f)), "-m", MODEL, "--json")
LIMIT_429 = re.compile(r"\b429\b|too many requests|usage limit|rate limit|hit your limit|try again (at|in)", re.I)
# With the code-mode host off, codex says once per run that its exec tool fails closed: the wanted state.
NOTICE = "Code Mode is unavailable because code-mode host is disabled"
LEAK = re.compile(r"hook:|skill", re.I)  # what the main home's hooks and skills print; a clean home prints neither
LOCK_NAMES = ("auth.lock", "auth.json.lock")  # codex creates both, then writes auth.json (seen 11 Nov)
GUARD = dt.timedelta(minutes=20)  # a call starts only if the pool's access token outlives the 900 s call cap


def _stamp(auth: Path) -> tuple[dt.datetime, dt.datetime, bytes] | None:
    """A login file's last refresh, its access token's expiry and its bytes, or None if there is none."""
    try:
        raw = auth.read_bytes()
    except FileNotFoundError:
        return None
    a = json.loads(raw)
    claims = a["tokens"]["access_token"].split(".")[1]
    exp = json.loads(base64.urlsafe_b64decode(claims + "=" * (-len(claims) % 4)))["exp"]
    return dt.datetime.fromisoformat(a["last_refresh"]), dt.datetime.fromtimestamp(exp, dt.timezone.utc), raw


def _left(home: Path) -> dt.timedelta:
    got = _stamp(home / "auth.json")
    return got[1] - dt.datetime.now(dt.timezone.utc) if got else dt.timedelta(0)


def _write(path: Path, raw: bytes) -> None:
    tmp = path.with_name(path.name + ".judge-tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, path)


@contextlib.contextmanager
def _file_lock(path: Path, wait_s: float):
    """Holds a byte-range lock on path that overlaps codex's whole-file lock on the same file."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    end = time.monotonic() + wait_s
    try:
        while True:
            try:
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() > end:
                    raise TimeoutError(f"{path} stayed locked for {wait_s:.0f} s") from None
                time.sleep(0.2)
        yield
    finally:
        os.close(fd)  # closing the handle drops the lock


class CodexJudge(Claude):
    """Claude.ask's logged retry loop over one `codex exec` run per attempt instead of one `claude -p` run."""

    def __init__(self, log: Path, slots: int = DEFAULT_SLOTS, home: Path = POOL_HOME, work: Path | None = None,
                 main_home: Path = MAIN_HOME) -> None:
        node = shutil.which("node")
        if not node or not CODEX_JS.exists():
            raise SystemExit(f"node or {CODEX_JS} not found: install @openai/codex with npm")
        self.cmd = [node, str(CODEX_JS), *FLAGS]
        work = work or log.parent / "codex-judge"
        self.cwd, self.sysdir = work / "cwd", work / "system-prompts"  # attributes Claude.ask and _log read
        profile = work / "profile"
        for d in (self.cwd, self.sysdir, profile, home):
            d.mkdir(parents=True, exist_ok=True)
        self.log_path, self.lock, self.model, self.n = log, threading.Lock(), MODEL, slots
        self.slots, self.solo = threading.BoundedSemaphore(slots), threading.Lock()
        self.home, self.main_home = home, main_home
        base = {k: v for k, v in os.environ.items() if k.upper() in KEEP_ENV}  # no OPENAI_* key: plan login only
        self.main_env = {**base, "CODEX_HOME": str(main_home)}
        # An empty profile: from any CODEX_HOME codex reads ~/.codex/auth.json and adopts it when newer (seen 11 Nov),
        # so only sync() moves a login between the homes.
        self.env = {k: v for k, v in base.items() if k.upper() not in ("HOMEDRIVE", "HOMEPATH")}
        self.env.update(CODEX_HOME=str(home), USERPROFILE=str(profile), HOME=str(profile))
        if _stamp(main_home / "auth.json") is None:
            raise SystemExit(f"no codex login in {main_home}: run `codex login`")
        self.sync()

    def ask(self, system: str, user: str, *, tag: str, effort: str = "medium", want_json: bool = False) -> dict:
        return super().ask(system, user, effort=effort, tag=tag, want_json=want_json)

    def sync(self) -> None:
        """Copies the newer login over the older under both homes' codex locks. Pool to main happens only if a pool
        run refreshed anyway, so main holds the new refresh token before it can reuse the spent one."""
        homes = (self.main_home, self.home)
        try:
            with contextlib.ExitStack() as st:
                for h in homes:
                    for name in LOCK_NAMES:
                        st.enter_context(_file_lock(h / name, 120))
                main, pool = (_stamp(h / "auth.json") for h in homes)
                if main is None:
                    raise SystemExit(f"the codex login in {self.main_home} is gone")
                if pool is None or main[0] > pool[0] or (main[0] == pool[0] and main[2] != pool[2]):
                    src, dst, raw = "main", "pool", main[2]
                elif pool[0] > main[0]:
                    src, dst, raw = "pool", "main", pool[2]
                else:
                    return
                _write((self.home if dst == "pool" else self.main_home) / "auth.json", raw)
                self._log({"event": "login-sync", "from": src, "to": dst, "main_refresh": str(main[0]),
                           "pool_refresh": str(pool[0]) if pool else None})
        except TimeoutError as e:  # the next call syncs again; nothing is lost by waiting
            self._log({"event": "login-sync-skipped", "why": str(e)})

    def _refresh_main(self) -> None:
        """One trivial run in the main home once its token has expired, so codex refreshes it there."""
        before = _stamp(self.main_home / "auth.json")[0]
        p = subprocess.run([*self.cmd, "-c", 'model_reasoning_effort="low"', "-"], input=b"Reply OK.",
                           capture_output=True, env=self.main_env, cwd=self.cwd, timeout=300)
        after = _stamp(self.main_home / "auth.json")[0]
        self._log({"event": "login-refresh", "rc": p.returncode, "main_before": str(before), "main_after": str(after)})
        if after == before:
            raise RuntimeError(f"codex did not refresh the expired login in {self.main_home}: run `codex login`")

    def _ready(self, deadline: float) -> bool:
        """True once the pool's access token outlives a call. Near expiry one thread drains the pool, waits for the
        main token to expire or for the user's codex to refresh it, refreshes it if needed and copies it in."""
        self.sync()
        if _left(self.home) > GUARD:
            return True
        if not self.solo.acquire(timeout=max(0.0, deadline - time.monotonic())):
            return False
        taken = 0
        try:
            while taken < self.n and self.slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
                taken += 1
            while taken == self.n:
                self.sync()
                if _left(self.home) > GUARD:
                    return True
                wait = _left(self.main_home).total_seconds() + 30
                if wait <= 0:
                    self._refresh_main()
                elif time.monotonic() + wait > deadline:
                    return False
                else:
                    self._log({"event": "login-wait", "delay_s": round(wait)})
                    time.sleep(min(wait, 600))  # looks again every 10 min: the user's codex may refresh first
            return False
        finally:
            for _ in range(taken):
                self.slots.release()
            self.solo.release()

    def _run(self, sys_file: Path, user: str, effort: str, deadline: float) -> tuple[dict, str] | None:
        """One `codex exec` run in the pool home, or None if no slot or fresh login comes before the deadline."""
        while self._ready(deadline):
            if not self.slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
                return None
            try:
                if _left(self.home) > GUARD:  # a drain may have run while this thread waited for its slot
                    return self._exec(sys_file.read_bytes().decode("utf-8"), user, effort, deadline)
            finally:
                try:
                    self.sync()
                finally:
                    self.slots.release()
        return None

    def _exec(self, system: str, user: str, effort: str, deadline: float) -> tuple[dict, str]:
        cmd = [*self.cmd, "-c", f'model_reasoning_effort="{effort}"', "-"]
        limit = max(1.0, min(900.0, deadline - time.monotonic()))
        try:
            p = subprocess.run(cmd, input=(PREAMBLE + system + "\n\n" + user).encode("utf-8"), capture_output=True,
                               env=self.env, cwd=self.cwd, timeout=limit)
        except subprocess.TimeoutExpired:
            return {"is_error": True, "result": f"timeout after {limit:.0f} s"}, ""
        out, err = p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")
        texts, items, errors, usage, loose = [], {}, [], None, []
        for line in out.splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                loose.append(line)
                continue
            kind, item = ev.get("type"), ev.get("item") or {}
            if kind == "item.completed":
                if item.get("type") == "error" and str(item.get("message")).startswith(NOTICE):
                    continue
                items[item.get("type")] = items.get(item.get("type"), 0) + 1
                if item.get("type") == "agent_message":
                    texts.append(item.get("text") or "")
            elif kind == "turn.completed":
                usage = ev.get("usage")
            elif kind in ("error", "turn.failed"):
                errors.append(str(ev.get("message") or (ev.get("error") or {}).get("message")))
        noise = "\n".join(loose) + "\n" + err
        if LEAK.search(noise):
            self._log({"event": "fail", "why": "the judge home loaded hooks or skills", "detail": noise[-400:]})
            raise RuntimeError(f"codex printed hook or skill lines; the judge home is not clean: {noise[-200:]}")
        extra = sorted(k for k in items if k not in ("agent_message", "reasoning"))
        res = {"result": texts[-1] if texts else "", "usage": usage, "modelUsage": {MODEL: {}}, "items": items}
        if p.returncode != 0 or errors or extra or not texts:
            res["is_error"] = True
            res["result"] = f"rc={p.returncode} errors={errors} extra_items={extra} {err[-200:]} {out[-400:]}"[:800]
        if LIMIT_429.search(" ".join(errors) + err):
            res["api_error_status"] = 429
        return res, err[-300:]


def main() -> None:
    """Smoke: python -I codex_judge.py LOG [N_CALLS] [SLOTS] [PROMPT_FILE] - N judge-sized calls, calls per minute."""
    from concurrent.futures import ThreadPoolExecutor
    log, n, slots = Path(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 1, \
        int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_SLOTS
    user = Path(sys.argv[4]).read_text(encoding="utf-8") if len(sys.argv) > 4 else "Is 2+2 equal to 4?"
    judge = CodexJudge(log, slots)
    sysp = 'Reply with {"label": "CORRECT"} or {"label": "WRONG"} and nothing else.'
    t0, ok, bad = time.monotonic(), 0, []

    def one(i: int) -> str:
        return judge.ask(sysp, f"[{i}] {user}", tag=f"smoke {slots}x{i}")["text"]

    with ThreadPoolExecutor(slots) as pool:
        for f in [pool.submit(one, i) for i in range(n)]:
            try:
                f.result()
                ok += 1
            except Exception as e:  # counted and named; a failed call is never a verdict
                bad.append(f"{type(e).__name__}: {e}"[:200])
    mins = (time.monotonic() - t0) / 60
    print(json.dumps({"slots": slots, "calls": n, "ok": ok, "errors": bad, "minutes": round(mins, 2),
                      "calls_per_min": round(ok / mins, 2)}))


if __name__ == "__main__":
    main()
