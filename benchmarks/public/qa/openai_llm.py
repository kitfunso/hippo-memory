"""OpenAI chat completions with a published script's settings, logged in the ledger's record shape (dated notes 22).

Claude.ask's retry loop over one HTTPS call per attempt. A 429 rate limit waits inside the call and is no ask; an
exhausted quota or a rejected key stops the process. Before every call the logged spend at list prices must be under
OPENAI_BENCH_CAP_USD, or the process stops. The key comes from OPENAI_API_KEY and never reaches a log.
Usage: OpenAIChat(log, Settings("gpt-4o-2024-08-06", max_tokens=10)).ask("", prompt, effort=EFFORT, tag="t")["text"]
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mem0"))
from claude_llm import Claude  # noqa: E402

URL = "https://api.openai.com/v1/chat/completions"
# USD per 1M tokens, input and output, at developers.openai.com/api/docs/pricing (read 16 Nov 2026)
PRICES = {"gpt-4o-2024-08-06": (2.50, 10.00), "gpt-4o-mini-2024-07-18": (0.15, 0.60),
          "gpt-4.1-mini-2025-04-14": (0.40, 1.60)}
# One file per process: Windows can split a line two processes append to one file at once (16 Nov)
SPEND = Path.home() / "hippo-bench" / "results-r2" / "logs" / "openai-spend.d"
RESUM_S = 30  # how often a process adds up the other processes' spend again
EFFORT = "none"  # these chat models take no reasoning effort; the ledger still compares the field
# Error codes only: every rate-limit message also links /account/billing (16 Nov)
FATAL = re.compile(r'"(?:insufficient_quota|invalid_api_key|billing_hard_limit_reached)"')
WAIT_S = re.compile(r"try again in ([\d.]+)(ms|s)", re.I)


@dataclass(frozen=True)
class Settings:
    model: str
    role: str = "user"  # the role the prompt goes in; the Mem0 paper's answerer sends one system message
    temperature: float = 0.0
    max_tokens: int | None = None
    json_object: bool = False

    @property
    def cli(self) -> str:
        """Stamped on every record, so the ledger never takes a reply made with other settings."""
        return (f"openai chat.completions role={self.role} temperature={self.temperature} "
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
        work = log.parent / "openai-work"
        self.cwd, self.sysdir = work / "cwd", work / "system-prompts"  # attributes Claude.ask and _log read
        for d in (self.cwd, self.sysdir, spend):
            d.mkdir(parents=True, exist_ok=True)
        self.log_path, self.lock, self.slots = log, threading.Lock(), threading.BoundedSemaphore(slots)
        self.settings, self.model, self.cli = settings, settings.model, settings.cli
        self.spend_dir, self.spend_path = spend, spend / f"{os.getpid()}-{time.time_ns()}.jsonl"
        self.cap = float(os.environ.get("OPENAI_BENCH_CAP_USD", "60")) if cap is None else cap
        self.spend_lock, self.mine, self.limits_logged = threading.Lock(), 0.0, False
        self.others, self.summed_at = spent(spend), time.monotonic()

    def _check_cap(self) -> None:
        with self.spend_lock:
            if time.monotonic() - self.summed_at > RESUM_S:
                self.others, self.summed_at = spent(self.spend_dir, skip=self.spend_path), time.monotonic()
            if self.others + self.mine >= self.cap:
                raise RuntimeError(f"openai spend cap: {self.others + self.mine:.2f} USD logged in {self.spend_dir}, "
                                   f"cap {self.cap:.2f} (OPENAI_BENCH_CAP_USD)")

    def _charge(self, model: str, usage: dict) -> float:
        usd = cost(model if model in PRICES else self.model, usage)
        line = json.dumps({"ts": round(time.time(), 3), "log": str(self.log_path), "model": model,
                           "prompt_tokens": usage.get("prompt_tokens"),
                           "completion_tokens": usage.get("completion_tokens"), "usd": round(usd, 6)}) + "\n"
        with self.spend_lock:
            self.mine += usd
            with self.spend_path.open("ab") as f:
                f.write(line.encode("utf-8"))
        return usd

    def _body(self, system: str, user: str) -> bytes:
        s = self.settings
        body = {"model": s.model, "temperature": s.temperature,
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
            resp, err = self._post(body, deadline)
        finally:
            self.slots.release()
        if resp is None:
            return err, ""
        usage, model = resp.get("usage") or {}, resp.get("model", "")
        usd = self._charge(model, usage)
        choice = (resp.get("choices") or [{}])[0]
        return {"result": (choice.get("message") or {}).get("content") or "", "modelUsage": {model: usage},
                "usage": usage, "total_cost_usd": usd, "finish_reason": choice.get("finish_reason")}, ""
