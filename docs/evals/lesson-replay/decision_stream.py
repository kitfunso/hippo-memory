import json
from decimal import Decimal
from typing import BinaryIO, Iterator

from price_route_b import RATES


class Stop(ValueError):
    pass


def require(condition: bool, reason: str = "malformed_decision") -> None:
    if not condition:
        raise Stop(reason)


def events(stream: BinaryIO) -> Iterator[dict]:
    name, data = "", []
    for line in stream:
        line = line.decode("utf-8").rstrip("\r\n")
        if not line:
            if data:
                event = json.loads("\n".join(data))
                require(isinstance(event, dict) and name == event.get("type"))
                yield event
            name, data = "", []
        elif line.startswith("event:"):
            name = line[6:].lstrip(" ")
        elif line.startswith("data:"):
            data.append(line[5:].removeprefix(" "))
    raise Stop("incomplete_stream")


def usd(model: str, usage: dict) -> str:
    ordinary, hourly, hit, output = RATES[model]
    writes = usage.get("cache_creation") or {}
    hour = writes.get("ephemeral_1h_input_tokens", 0)
    short = writes.get("ephemeral_5m_input_tokens", 0)
    reads = usage.get("cache_read_input_tokens", 0)
    total = usage.get("cache_creation_input_tokens", 0)
    counts = (usage["input_tokens"], hour, short, reads, total, usage["output_tokens"])
    require(all(type(n) is int and n >= 0 for n in counts) and hour + short == total, "invalid_usage")
    cost = counts[0] * ordinary + hour * hourly + short * ordinary * Decimal("1.25") + reads * hit
    return format((cost + counts[-1] * output) / Decimal(1000000), "f")


def update_block(block: dict, delta: dict) -> None:
    kind = delta["type"]
    fields = {"input_json_delta": ("tool_use", "partial_json"), "text_delta": ("text", "text"),
              "thinking_delta": ("thinking", "thinking"), "signature_delta": ("thinking", "signature")}
    require(kind in fields)
    target, field = fields[kind]
    require(block["type"] == target and isinstance(delta[field], str))
    if kind == "input_json_delta":
        block.setdefault("parts", []).append(delta[field])


def finish_block(block: dict, commands: list, ids: set) -> None:
    if block["type"] != "tool_use":
        return
    name, tool_id = block["name"], block["id"]
    require(isinstance(name, str) and bool(name) and isinstance(tool_id, str) and bool(tool_id) and tool_id not in ids)
    ids.add(tool_id)
    args = block["input"]
    if "parts" in block and (fragment := "".join(block["parts"])):
        require(args == {})
        args = json.loads(fragment)
    require(isinstance(args, dict))
    if name in ("Bash", "PowerShell"):
        require(isinstance(args.get("command"), str))
        commands.append(args["command"])


def credit_error(error: dict) -> bool:
    detail = str(error.get("message", "")).lower()
    return error.get("type") == "credit_balance_error" or "credit balance" in detail or "insufficient credits" in detail


def decision(stream: BinaryIO, model: str, receipt: dict) -> list:
    commands, ids = [], set()
    block, index, started, final_usage, reason = None, 0, False, False, None
    for event in events(stream):
        kind = event["type"]
        if kind == "ping":
            continue
        if kind == "error":
            raise Stop("credit_balance" if credit_error(event["error"]) else "stream_error")
        if kind == "message_start":
            msg = event["message"]
            require(not started and msg["role"] == "assistant" and msg["type"] == "message" and msg["content"] == [])
            require(isinstance(msg["id"], str) and bool(msg["id"]))
            receipt["usage"].update(msg["usage"])
            receipt["responseModel"] = msg["model"]
            require(msg["model"] == model, "model_mismatch")
            started = True
        elif kind == "content_block_start":
            require(started and block is None and not reason and event["index"] == index)
            block = event["content_block"]
            require(block["type"] in ("text", "tool_use", "thinking", "redacted_thinking"))
            field = {"text": "text", "thinking": "thinking", "redacted_thinking": "data"}.get(block["type"])
            require(field is None or isinstance(block.get(field), str))
        elif kind in ("content_block_delta", "content_block_stop"):
            require(block is not None and event["index"] == index)
            if kind == "content_block_delta":
                update_block(block, event["delta"])
            else:
                finish_block(block, commands, ids)
                index += 1
                block = None
        elif kind == "message_delta":
            require(started and block is None)
            usage = event.get("usage") or {}
            receipt["usage"].update({k: v for k, v in usage.items() if v is not None})
            final_usage |= type(usage.get("output_tokens")) is int
            reason = event["delta"].get("stop_reason") or reason
            require(event["delta"].get("model", model) == model, "model_mismatch")
        elif kind == "message_stop":
            require(started and block is None and isinstance(reason, str) and bool(reason))
            require(reason != "tool_use" or bool(ids))
            require(final_usage, "invalid_usage")
            receipt["usd"] = usd(model, receipt["usage"])
            receipt["usageFinal"] = True
            return commands
        else:
            raise Stop("unknown_stream_event")
    raise Stop("incomplete_stream")
