"""OpenAI chat completions with a published script's settings, logged in the ledger's record shape (dated notes 22).

Claude.ask's retry loop over one HTTPS call per attempt. A 429 rate limit waits inside the call and is no ask; an
exhausted quota or a rejected key stops the process. Before every call the logged spend at list prices must be under
OPENAI_BENCH_CAP_USD, or the process stops. The key comes from OPENAI_API_KEY and never reaches a log.
Free daily tokens (dated notes 30): a call goes only if today's UTC tokens of its pool, in every spend folder and in
flight, plus its own worst case stay inside OPENAI_FREE_DAILY_BIG or _SMALL; else it waits for 00:00:30 UTC.
Usage: OpenAIChat(log, Settings("gpt-4o-2024-08-06", max_tokens=10)).ask("", prompt, effort=EFFORT, tag="t")["text"]
"""
from __future__ import annotations

import itertools
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

sys.path[:0] = [str(Path(__file__).resolve().parents[1] / "mem0"), str(Path(__file__).resolve().parents[1])]
from claude_llm import DEADLINE_S, Claude  # noqa: E402
from qa.ledger import pid_alive  # noqa: E402

URL = "https://api.openai.com/v1/chat/completions"
# USD per 1M tokens, input and output, at developers.openai.com/api/docs/pricing (read 16 Nov 2026)
PRICES = {"gpt-4o-2024-08-06": (2.50, 10.00), "gpt-4o-mini-2024-07-18": (0.15, 0.60), "gpt-4o-mini": (0.15, 0.60),
          "gpt-4.1-mini-2025-04-14": (0.40, 1.60)}
# The org's free-token pools on traffic shared with OpenAI (Keith, 17 Nov 2026); a model in neither would bill
BIG = ("gpt-4o-2024-08-06", "gpt-4.1", "gpt-5-2025-08-07", "gpt-5.6-sol")
SMALL = ("gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-4.1-mini-2025-04-14")
# Max output tokens, the worst case of a call sent with no token limit (developers.openai.com/api/docs/models, 17 Nov)
MAX_OUT = {"gpt-4o-2024-08-06": 16_384, "gpt-4o-mini": 16_384, "gpt-4o-mini-2024-07-18": 16_384, "gpt-4.1": 32_768,
           "gpt-4.1-mini-2025-04-14": 32_768, "gpt-5-2025-08-07": 128_000}
INPUT_LIMIT = {"gpt-5-2025-08-07": 272_000}  # the API refuses a longer prompt unbilled (dated notes 29)
DAY_S, WAKE_S = 86_400, 30  # the free day starts at 00:00 UTC; a waiting call wakes 30 s after it
# One file per process: Windows can split a line two processes append to one file at once (16 Nov)
SPEND = Path.home() / "hippo-bench" / "results-r2" / "logs" / "openai-spend.d"
RESUM_S = 30  # how often a process adds up the other processes' spend again
_CLIENTS = itertools.count()
_FREE_LOCK = threading.Lock()  # the threads of one process take the free-token file lock one at a time
EFFORT = "none"  # these chat models take no reasoning effort; the ledger still compares the field
# Error codes only: every rate-limit message also links /account/billing (16 Nov)
FATAL = re.compile(r'"(?:insufficient_quota|invalid_api_key|billing_hard_limit_reached)"')
WAIT_S = re.compile(r"try again in ([\d.]+)(ms|s)", re.I)
utc_now = time.time  # one clock for spend records and the free day, so a test can move it


@dataclass(frozen=True)
class Settings:
    model: str
    role: str = "user"  # the role the prompt goes in; the Mem0 paper's answerer sends one system message
    temperature: float | None = 0.0  # None sends none, so the API's default applies
    max_tokens: int | None = None
    json_object: bool = False

    @property
    def cli(self) -> str:
        """Stamped on every record, so the ledger never takes a reply made with other settings."""
        temp = "unset" if self.temperature is None else self.temperature
        return (f"openai chat.completions role={self.role} temperature={temp} "
                f"max_tokens={self.max_tokens} json_object={self.json_object}")


def cost(model: str, usage: dict) -> float:
    """List price of one call; cached input is priced as fresh input, so the cap errs high."""
    pin, pout = PRICES[model]
    return ((usage.get("prompt_tokens") or 0) * pin + (usage.get("completion_tokens") or 0) * pout) / 1e6


def spent(folder: Path, skip: Path | None = None) -> float:
    """USD logged by every process's spend file but `skip`; a last line a kill cut short is not counted."""
    total = 0.0
    for f in folder.glob("*.jsonl"):
        if f != skip:
            raw = f.read_bytes()
            total += sum(json.loads(line)["usd"] for line in raw[:raw.rfind(b"\n") + 1].split(b"\n") if line.strip())
    return total


def pool_of(model: str) -> str | None:
    return "big" if model in BIG else "small" if model in SMALL else None


def free_caps() -> dict[str, int]:
    return {"big": int(os.environ.get("OPENAI_FREE_DAILY_BIG") or 250_000),
            "small": int(os.environ.get("OPENAI_FREE_DAILY_SMALL") or 2_500_000)}


def worst_case(body: dict) -> tuple[int, int]:
    """The request's prompt tokens by o200k, each message's framing counted high, and the most it may write."""
    try:
        import tiktoken
    except ImportError:
        raise SystemExit("tiktoken is missing: the free-token cap counts prompts with it (pip install tiktoken)") from None
    enc = tiktoken.get_encoding("o200k_base")
    prompt = sum(len(enc.encode(m["content"], disallowed_special=())) + 8 for m in body["messages"]) + 16
    return prompt, body.get("max_tokens") or body.get("max_completion_tokens") or MAX_OUT[body["model"]]


@contextmanager
def file_lock(path: Path):
    """An exclusive lock across processes, so a free-token check and its reservation are one step."""
    fd = os.open(path, os.O_RDWR | os.O_CREAT)
    try:
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
                    break
                except OSError:  # LK_LOCK gives up after 10 s of another holder
                    pass
            try:
                yield
            finally:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX)
            yield
    finally:
        os.close(fd)


class FreeCapWait(Exception):
    def __init__(self, pool: str, used: int, need: int, cap: int) -> None:
        super().__init__(f"{pool} pool: {used} tokens counted today, this call needs up to {need}, cap {cap}")
        self.pool, self.used, self.need, self.cap = pool, used, need, cap


class FreeTokens:
    """Today's UTC tokens per pool in every openai-spend*.d folder beside `spend`, read as the files grow, plus the
    worst cases in flight of every live client, which each keeps in its own `.inflight` file."""

    def __init__(self, spend: Path, mine: Path) -> None:
        self.spend, self.mine, self.lock = spend, mine.with_suffix(".inflight"), spend.parent / "openai-free-tokens.lock"
        self.offsets: dict[Path, int] = {}
        self.used: Counter = Counter()  # (UTC day, pool) -> tokens logged
        self.held: Counter = Counter()  # pool -> this client's worst cases in flight

    def _dirs(self) -> set[Path]:
        return {self.spend, *self.spend.parent.glob("openai-spend*.d")}  # gpt-5 logs to a folder of its own

    def _read(self) -> None:
        for f in (f for d in self._dirs() for f in d.glob("*.jsonl")):
            start = self.offsets.get(f, 0)
            if f.stat().st_size <= start:
                continue
            with f.open("rb") as h:
                h.seek(start)
                raw = h.read()
            raw = raw[:raw.rfind(b"\n") + 1]  # a line still being written counts on a later read
            self.offsets[f] = start + len(raw)
            for r in (json.loads(line) for line in raw.split(b"\n") if line.strip()):
                day = int((r.get("ts") or utc_now()) // DAY_S)  # a record with no time counts as today's
                pool = r.get("pool") or pool_of(r.get("model") or "")
                self.used[(day, pool)] += (r.get("prompt_tokens") or 0) + (r.get("completion_tokens") or 0)

    def _in_flight(self) -> Counter:
        """A killed client's file is dropped: its pid is gone, or it is older than any call can run."""
        total: Counter = Counter()
        for f in (f for d in self._dirs() for f in d.glob("*.inflight")):
            try:
                r = json.loads(f.read_bytes())
            except ValueError:  # cut short by a kill mid-write
                r = {}
            if not pid_alive(r.get("pid", 0)) or utc_now() - r.get("ts", 0) > DEADLINE_S + 3600:
                f.unlink(missing_ok=True)
                continue
            total.update({p: r.get(p, 0) for p in ("big", "small")})
        return total

    def _write(self) -> None:
        if any(self.held.values()):
            self.mine.write_text(json.dumps({"pid": os.getpid(), "ts": round(utc_now(), 3), **self.held}))
        else:
            self.mine.unlink(missing_ok=True)

    def take(self, pool: str, need: int, cap: int) -> tuple[bool, int]:
        """Holds `need` tokens of today's pool if they fit under `cap`; the tokens counted before it either way."""
        with _FREE_LOCK, file_lock(self.lock):
            self._read()
            used = self.used[(int(utc_now() // DAY_S), pool)] + self._in_flight()[pool]
            if used + need > cap:
                return False, used
            self.held[pool] += need
            self._write()
            return True, used

    def give_back(self, pool: str, need: int) -> None:
        with _FREE_LOCK, file_lock(self.lock):
            self.held[pool] -= need
            self._write()


def api_key() -> str:
    """OPENAI_API_KEY from the process, else the User env var a shell older than the key has not picked up."""
    key = os.environ.get("OPENAI_API_KEY", "")
    if key or os.name != "nt":
        return key
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as k:
            return str(winreg.QueryValueEx(k, "OPENAI_API_KEY")[0])
    except OSError:
        return ""


def retry_after(headers, detail: str) -> float:
    """Seconds a 429 asks us to wait: the header, else the message's 'try again in', else 5."""
    for name, scale in (("retry-after-ms", 0.001), ("retry-after", 1.0)):
        try:
            return float(headers.get(name)) * scale
        except (TypeError, ValueError):
            pass
    m = WAIT_S.search(detail)
    return float(m.group(1)) * (0.001 if m.group(2).lower() == "ms" else 1.0) if m else 5.0


class OpenAIChat(Claude):
    """Claude.ask's logged retry loop over one chat completions call per attempt instead of one `claude -p` run."""

    def __init__(self, log: Path, settings: Settings, slots: int = 8, spend: Path = SPEND,
                 cap: float | None = None) -> None:
        self._key = api_key()
        if not self._key:
            raise SystemExit("OPENAI_API_KEY is not set, in the process or as a User env var")
        if settings.model not in PRICES:
            raise SystemExit(f"{settings.model} has no list price in qa/openai_llm.py PRICES")
        self.pool = pool_of(settings.model)
        if self.pool is None:
            raise SystemExit(f"{settings.model} is in neither free-token pool (qa/openai_llm.py BIG, SMALL), so every "
                             "call would bill: add it to the pool OpenAI lists it in")
        work = log.parent / "openai-work"
        self.cwd, self.sysdir = work / "cwd", work / "system-prompts"  # attributes Claude.ask and _log read
        for d in (self.cwd, self.sysdir, spend):
            d.mkdir(parents=True, exist_ok=True)
        self.log_path, self.lock, self.slots = log, threading.Lock(), threading.BoundedSemaphore(slots)
        self.settings, self.model, self.cli = settings, settings.model, settings.cli
        # one file per client: two clients built in one clock tick (answer and judge) once shared a file (16 Nov)
        self.spend_dir, self.spend_path = spend, spend / f"{os.getpid()}-{time.time_ns()}-{next(_CLIENTS)}.jsonl"
        self.cap = float(os.environ.get("OPENAI_BENCH_CAP_USD", "60")) if cap is None else cap
        self.spend_lock, self.mine, self.limits_logged = threading.Lock(), 0.0, False
        self.others, self.summed_at = spent(spend), time.monotonic()
        self.free, self.free_cap, self.waits_logged = FreeTokens(spend, self.spend_path), free_caps()[self.pool], set()
        worst_case(json.loads(self._body("", "")))  # a model with no token limit and no MAX_OUT stops here, not mid-run

    def ask(self, system: str, user: str, *, effort: str, tag: str, want_json: bool = False) -> dict:
        """Claude.ask, run again from the start after the wait for the next free day, so its deadline never runs out."""
        while True:
            try:
                return super().ask(system, user, effort=effort, tag=tag, want_json=want_json)
            except FreeCapWait as w:
                wake = (int(utc_now() // DAY_S) + 1) * DAY_S + WAKE_S
                with self.spend_lock:
                    first = (w.pool, wake) not in self.waits_logged
                    self.waits_logged.add((w.pool, wake))
                if first:
                    until = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(wake))
                    self._log({"tag": tag, "event": "free-cap-wait", "pool": w.pool, "used": w.used, "need": w.need,
                               "cap": w.cap, "until": until})
                    print(f"free-cap-wait: {w}; sleeping until {until}", file=sys.stderr, flush=True)
                time.sleep(max(0.0, wake - utc_now()))

    @contextmanager
    def _free_tokens(self, body: bytes):
        """Holds the call's worst case against today's free tokens of its pool while it runs and is charged."""
        b = json.loads(body)
        prompt, out = worst_case(b)
        if prompt > INPUT_LIMIT.get(b["model"], float("inf")) * 1.02:  # 2% over the count, so surely refused
            yield
            return
        need = prompt + out
        if need > self.free_cap:
            raise RuntimeError(f"one {b['model']} call needs up to {need} tokens, over the whole free day of the "
                               f"{self.pool} pool ({self.free_cap}): it would bill, so it needs the owner's yes")
        ok, used = self.free.take(self.pool, need, self.free_cap)
        if not ok:
            raise FreeCapWait(self.pool, used, need, self.free_cap)
        try:
            yield
        finally:
            self.free.give_back(self.pool, need)

    def _check_cap(self) -> None:
        with self.spend_lock:
            if time.monotonic() - self.summed_at > RESUM_S:
                self.others, self.summed_at = spent(self.spend_dir, skip=self.spend_path), time.monotonic()
            if self.others + self.mine >= self.cap:
                raise RuntimeError(f"openai spend cap: {self.others + self.mine:.2f} USD logged in {self.spend_dir}, "
                                   f"cap {self.cap:.2f} (OPENAI_BENCH_CAP_USD)")

    def _charge(self, model: str, usage: dict) -> float:
        usd = cost(model if model in PRICES else self.model, usage)
        line = json.dumps({"ts": round(utc_now(), 3), "log": str(self.log_path), "model": model, "pool": self.pool,
                           "prompt_tokens": usage.get("prompt_tokens"),
                           "completion_tokens": usage.get("completion_tokens"), "usd": round(usd, 6)}) + "\n"
        with self.spend_lock:
            self.mine += usd
            with self.spend_path.open("ab") as f:
                f.write(line.encode("utf-8"))
        return usd

    def _body(self, system: str, user: str) -> bytes:
        s = self.settings
        body = {"model": s.model, **({} if s.temperature is None else {"temperature": s.temperature}),
                "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": s.role, "content": user}]}
        if s.max_tokens is not None:
            body["max_tokens"] = s.max_tokens
        if s.json_object:
            body["response_format"] = {"type": "json_object"}
        return json.dumps(body).encode("utf-8")

    def _post(self, body: bytes, deadline: float) -> tuple[dict | None, dict]:
        """The reply, or None and an error result. A 429 waits and posts again until the deadline."""
        while True:
            self._check_cap()
            req = urllib.request.Request(URL, data=body, headers={"Authorization": f"Bearer {self._key}",
                                                                   "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=max(1.0, min(300.0, deadline - time.monotonic()))) as r:
                    if not self.limits_logged:
                        self.limits_logged = True
                        self._log({"event": "openai-limits", **{k: r.headers.get(k) for k in (
                            "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens")}})
                    return json.load(r), {}
            except urllib.error.HTTPError as e:
                detail = e.read().decode("utf-8", "replace")[-400:]
                if FATAL.search(detail) or e.code in (401, 403):
                    raise RuntimeError(f"openai refused the key or the account: HTTP {e.code} {detail}") from None
                if e.code != 429:
                    return None, {"is_error": True, "api_error_status": e.code, "result": detail}
                wait = min(retry_after(e.headers, detail) + 0.5, 120.0)
                if time.monotonic() + wait > deadline:
                    return None, {"is_error": True, "api_error_status": 429, "result": detail}
                self._log({"event": "limit-wait", "delay_s": round(wait, 1), "detail": detail[:200]})
                time.sleep(wait)
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                return None, {"is_error": True, "result": f"{type(e).__name__}: {e}"[:300]}

    def _run(self, sys_file: Path, user: str, effort: str, deadline: float,
             account: str | None = None) -> tuple[dict, str] | None:
        """One chat completions call, or None if no slot frees up before the deadline."""
        body = self._body(sys_file.read_bytes().decode("utf-8"), user)
        if not self.slots.acquire(timeout=max(0.0, deadline - time.monotonic())):
            return None
        try:
            with self._free_tokens(body):  # released only after the charge is logged, so no moment counts neither
                resp, err = self._post(body, deadline)
                if resp is not None:
                    usage, model = resp.get("usage") or {}, resp.get("model", "")
                    usd = self._charge(model, usage)
        finally:
            self.slots.release()
        if resp is None:
            return err, ""
        choice = (resp.get("choices") or [{}])[0]
        return {"result": (choice.get("message") or {}).get("content") or "", "modelUsage": {model: usage},
                "usage": usage, "total_cost_usd": usd, "finish_reason": choice.get("finish_reason")}, ""
