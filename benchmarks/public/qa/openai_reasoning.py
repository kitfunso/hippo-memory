"""gpt-5 on chat completions as Mem0's LLMClient sends it (prereg dated notes 29): no temperature, max_completion_tokens.

memory-benchmarks benchmarks/common/llm_client.py lines 71 to 83 drop temperature and send max_completion_tokens for
gpt-5; generate_structured adds response_format json_object (line 273). Content "" is the answer "" there (line 185),
so it is logged as an ask with the text CUT, which reply_text reads back as "". Content None is asked again, as there.
A prompt over the API's 272,000 input tokens is refused with HTTP 400; that client retries and then returns "" (lines
186 to 193), so it is logged as one ask with the text TOO_LONG, read back as "", and costs nothing.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from qa.openai_llm import PRICES, SPEND, OpenAIChat

PRICES.setdefault("gpt-5-2025-08-07", (1.25, 10.00))  # developers.openai.com/api/docs/pricing, read 16 Nov 2026
CUT = "<the API returned empty content>"
TOO_LONG = "<the API refused the prompt: context_length_exceeded>"
EFFORT = "default"  # no reasoning_effort is sent, so the API's default applies
# SHORTCUT: own spend folder, so lanes launched with a $500 cap never stop on gpt-5 spend; totals add both folders
GPT5_SPEND = SPEND.parent / "openai-spend-gpt5.d"


@dataclass(frozen=True)
class ReasoningSettings:
    model: str
    max_completion_tokens: int = 4096  # llm_client.generate and generate_structured default max_tokens
    json_object: bool = False
    role: str = "user"

    @property
    def cli(self) -> str:
        """Stamped on every record, so the ledger never takes a reply made with other settings."""
        return (f"openai chat.completions role={self.role} temperature=unset "
                f"max_completion_tokens={self.max_completion_tokens} json_object={self.json_object}")


def reply_text(text: str) -> str:
    return "" if text in (CUT, TOO_LONG) else text


class ReasoningChat(OpenAIChat):
    """OpenAIChat with the request body Mem0's client sends a gpt-5 model."""

    def __init__(self, log: Path, settings: ReasoningSettings, slots: int = 8, spend: Path = GPT5_SPEND,
                 cap: float | None = None) -> None:
        super().__init__(log, settings, slots=slots, spend=spend, cap=cap)  # type: ignore[arg-type]

    def _body(self, system: str, user: str) -> bytes:
        s = self.settings
        body = {"model": s.model, "max_completion_tokens": s.max_completion_tokens,
                "messages": ([{"role": "system", "content": system}] if system else []) + [{"role": s.role, "content": user}]}
        if s.json_object:
            body["response_format"] = {"type": "json_object"}
        return json.dumps(body).encode("utf-8")

    def _post(self, body: bytes, deadline: float) -> tuple[dict | None, dict]:
        resp, err = super()._post(body, deadline)
        if resp is None and err.get("api_error_status") == 400 and "context_length_exceeded" in str(err.get("result")):
            return {"model": self.model, "usage": {}, "choices": [{"message": {"content": TOO_LONG},
                                                                   "finish_reason": "context_length_exceeded"}]}, {}
        msg = ((resp or {}).get("choices") or [{}])[0].get("message") or {}
        if msg.get("content") == "":
            msg["content"] = CUT
        return resp, err
