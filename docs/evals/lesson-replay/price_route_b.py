"""Price the frozen decision requests offline. No HTTP client or credential lookup."""
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from functools import cache
from hashlib import sha256
import json

from route_b import ARCHIVE, CORPUS, CORPUS_SEAL, RECEIPTS_SEAL, SONNET, packed, read, variant


# USD per million tokens: ordinary input, one-hour write, hit, output.
RATES = {"claude-opus-5-5": (4, 8, Decimal("0.20"), 20), SONNET: (2, 4, Decimal("0.10"), 10)}
SECONDS_PER_CALL = 30
TTL_SECONDS = 3600


@dataclass(frozen=True)
class Demand:
    model: str
    key: bytes
    ordinary: int
    prefix: int
    output: int


def prefix_key(body: dict, tail: list) -> bytes:
    # The final original cache marker also covers every preceding tool and message.
    messages = body["messages"][:-1] + [dict(body["messages"][-1], content=tail)]
    return sha256(packed([body["model"], body["tools"], body["system"], messages,
                          body["thinking"], body["output_config"], body["context_management"]])).digest()


def demand(raw: bytes, row: dict, arm: str, usage: dict) -> Demand:
    original = json.loads(raw)
    body = json.loads(variant(raw, row, arm))
    cached = usage["cache_read_input_tokens"] + usage["cache_creation_input_tokens"]
    total = cached + usage["input_tokens"]
    if usage["cache_creation_input_tokens"] != usage["cache_creation"]["ephemeral_1h_input_tokens"]:
        raise ValueError("Unexpected historical cache TTL")
    tail = body["messages"][-1]["content"]
    mark = len(original["messages"][-1]["content"])
    markers = [b.get("cache_control") for b in [*body["tools"], *body["system"],
               *(b for m in body["messages"] for b in m["content"])] if "cache_control" in b]
    if tail[mark-1].get("cache_control", {}).get("ttl") != "1h" or any(m.get("ttl") != "1h" for m in markers):
        raise ValueError("Unexpected replay cache breakpoints")
    basis = sum(len(packed(original[k])) for k in ("tools", "system", "messages"))
    delta = len(packed(body["messages"][0])) - len(packed(original["messages"][0]))
    suffix = len(packed(tail)) - len(packed(tail[:mark]))
    prefix = cached + round(total * delta / basis)
    ordinary = usage["input_tokens"] + round(total * suffix / basis)
    return Demand(body["model"], prefix_key(body, tail[:mark]), ordinary, prefix, usage["output_tokens"])


def costs(model: str, counts: Counter) -> dict:
    base, write, hit, out = RATES[model]
    entire = counts["ordinary"] + counts["write"] + counts["read"]
    output = counts["output"] * out
    return {
        "uncached": Decimal(entire * base + output) / 10**6,
        "cached": (counts["ordinary"] * base + counts["write"] * write + counts["read"] * hit + output) / 10**6,
        "all_miss": Decimal(counts["ordinary"] * base + (entire - counts["ordinary"]) * write + output) / 10**6,
    }


def summarize(groups: dict) -> dict:
    counts = sum(groups.values(), Counter())
    prices = defaultdict(Decimal)
    for model, tokens in groups.items():
        for scenario, cost in costs(model, tokens).items():
            prices[scenario] += cost
    return {**counts, "total_input": counts["ordinary"] + counts["write"] + counts["read"],
            "usd": {key: f"{cost:.2f}" for key, cost in prices.items()}}


def estimate() -> dict:
    if sha256((ARCHIVE / "receipts.json").read_bytes()).hexdigest() != RECEIPTS_SEAL:
        raise ValueError("Decision receipts differ from registration")
    if sha256((CORPUS / "seal.json").read_bytes()).hexdigest() != CORPUS_SEAL:
        raise ValueError("Corpus seal differs from registration")
    seal = read(CORPUS / "seal.json")
    for name in ("manifest.json", "smoke.json", "gate.json", "treatment.json"):
        if sha256((CORPUS / name).read_bytes()).hexdigest() != seal[name]:
            raise ValueError("Frozen schedule or manifest changed")
    rows = {r["sid"]: r for r in read(CORPUS / "manifest.json")}
    receipts = read(ARCHIVE / "receipts.json")

    @cache
    def size(sid: str, arm: str) -> Demand:
        raw = (ARCHIVE / "bodies" / (sid + ".json")).read_bytes()
        if sha256(raw).hexdigest() != receipts[sid]["sha256"]:
            raise ValueError("Original body changed")
        return demand(raw, rows[sid], arm, receipts[sid]["usage"])

    phases = {}
    full = defaultdict(Counter)
    for phase in ("smoke", "gate", "treatment"):
        last_seen = {}
        groups = defaultdict(Counter)
        for index, job in enumerate(read(CORPUS / (phase + ".json"))):
            req = size(job["sid"], job["arm"])
            now = index * SECONDS_PER_CALL
            hit = req.key in last_seen and now - last_seen[req.key] < TTL_SECONDS
            last_seen[req.key] = now
            groups[req.model].update(calls=1, ordinary=req.ordinary, output=req.output,
                                     write=0 if hit else req.prefix, read=req.prefix if hit else 0)
        phases[phase] = {**summarize(groups), "models": {m: summarize({m: t}) for m, t in groups.items()}}
        if phase != "smoke":
            for model, counts in groups.items():
                full[model].update(counts)
    phases["full_after_smoke"] = summarize(full)
    return phases


if __name__ == "__main__":
    print(json.dumps(estimate(), indent=2))
