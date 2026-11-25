import io
import json
import os
from collections import deque
from contextlib import contextmanager, redirect_stdout
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

from send_route_b import ARCHIVE, BACKUP, CORPUS, PRIMARY, Stop, analyze, history, inputs, phase, read, record, send
from route_b import variant


def stream(model: str, commands: list) -> list:
    usage = {"input_tokens": 2, "cache_creation_input_tokens": 12, "cache_read_input_tokens": 4,
             "cache_creation": {"ephemeral_1h_input_tokens": 10, "ephemeral_5m_input_tokens": 2}, "output_tokens": 1}
    events = [dict(type="message_start", message=dict(type="message", role="assistant", id="sample",
                   model=model, content=[], usage=usage)), dict(type="ping")]
    for index, (name, command) in enumerate(commands):
        events.append(dict(type="content_block_start", index=index, content_block=dict(type="tool_use",
                           name=name, id=str(index), input={})))
        payload = json.dumps({"command": command})
        for part in (payload[:4], payload[4:]):
            events.append(dict(type="content_block_delta", index=index, delta=dict(type="input_json_delta",
                               partial_json=part)))
        events.append(dict(type="content_block_stop", index=index))
    reason = "tool_use" if commands else "end_turn"
    return [*events, dict(type="message_delta", delta={"stop_reason": reason},
                          usage={"output_tokens": 5}), dict(type="message_stop")]


def wire(events: list) -> bytes:
    return "".join("event: " + e["type"] + "\ndata: " + json.dumps(e) + "\n\n" for e in events).encode()


@contextmanager
def endpoint(replies: list):
    queue, seen = deque(replies), []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            seen.append((self.path, self.headers, self.rfile.read(int(self.headers["Content-Length"]))))
            status, body = queue.popleft()
            self.send_response(status)
            self.send_header("Content-Type", "text/event-stream" if status == 200 else "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args: object) -> None:
            return

    with HTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02})
        thread.start()
        try:
            yield lambda: HTTPConnection(*server.server_address, timeout=3), seen
        finally:
            server.shutdown()
            thread.join()


def offline_key(name: str) -> None:
    os.environ["ANTHROPIC_API_KEY"] = "offline-" + name


class SenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tables = inputs()
        cls.plan = read(CORPUS / "smoke.json")
        cls.job = cls.plan[0]
        cls.row = cls.tables[0][cls.job["sid"]]
        cls.raw = (ARCHIVE / "bodies" / (cls.job["sid"] + ".json")).read_bytes()
        cls.events = stream(cls.row["model"], [("Bash", "pytest tests/"), ("PowerShell", 'pytest -k "not _int"')])

    def test_grades_cost_and_stops(self) -> None:
        bad_json = [dict(e) for e in self.events]
        bad_json[3] = dict(bad_json[3], delta=dict(type="input_json_delta", partial_json="broken"))
        valid = self.events
        cases = [(valid, 0), (stream(self.row["model"], []), 3),
                 (stream(self.row["model"], [("PowerShell", "pytest")]), 1),
                 (valid[:-1], "incomplete_stream"), (bad_json, "JSONDecodeError"),
                 (stream("other", []), "model_mismatch"), ([valid[0], valid[0]], "malformed_decision"),
                 ([valid[0], {"type": "error", "error": {"type": "overloaded_error"}}], "stream_error")]
        with endpoint([(200, wire(events)) for events, _ in cases]) as (connect, seen):
            with patch.dict(os.environ, ANTHROPIC_API_KEY="offline"):
                for _, expected in cases:
                    result = send(self.job, self.row, self.raw, PRIMARY, connect)
                    self.assertEqual(result.get("grade", result.get("error")), expected)
                    if isinstance(expected, int):
                        self.assertEqual(result["pass"], expected == 0)
                        self.assertEqual(float(result["usd"]), 0.0001988)
                    elif expected == "incomplete_stream":
                        self.assertEqual(result["usage"]["output_tokens"], 5)
            self.assertEqual(len(seen), len(cases))
            for path, headers, raw in seen:
                self.assertEqual((path, raw), ("/v1/messages", self.raw))
                self.assertEqual(headers["anthropic-version"], "2023-06-01")
                self.assertEqual(headers["anthropic-beta"],
                                 "context-management-2025-06-27,mid-conversation-output-config-2026-07-01")

    def test_zero_draw_restart_and_completed_resume(self) -> None:
        replies = [(400, b'{"error":{"message":"Your credit balance is too low"}}')]
        for job in self.plan:
            row = self.tables[0][job["sid"]]
            commands = [("Bash", 'pytest -k "not _int"')] if row["pass"] else []
            replies.append((200, wire(stream(row["model"], commands))))
        with TemporaryDirectory() as tmp, endpoint(replies) as (connect, seen), redirect_stdout(io.StringIO()):
            root = Path(tmp)
            for _ in range(2):
                self.assertTrue(phase("smoke", self.tables, connect, offline_key, root))
            self.assertEqual(len(seen), 1 + len(self.plan))
            self.assertEqual(seen[0][1]["x-api-key"], "offline-" + PRIMARY)
            for job, (_, headers, raw) in zip(self.plan, seen[1:], strict=True):
                self.assertEqual(raw, (ARCHIVE / "bodies" / (job["sid"] + ".json")).read_bytes())
                self.assertEqual(headers["x-api-key"], "offline-" + BACKUP)
            stopped = root / "smoke.first-key-stop.jsonl"
            self.assertEqual(analyze("smoke", stopped)["completed"], 0)
            self.assertEqual(analyze("smoke", root / "smoke.jsonl")["status"], "PASS")

    def test_uncertain_or_failed_draw_never_repeats(self) -> None:
        with TemporaryDirectory() as tmp, endpoint([(429, b"{}")]) as (connect, seen), redirect_stdout(io.StringIO()):
            root = Path(tmp)
            with self.assertRaisesRegex(Stop, "gate_closed"):
                phase("gate", self.tables, connect, offline_key, root)
            for _ in range(2):
                self.assertFalse(phase("smoke", self.tables, connect, offline_key, root))
            self.assertEqual(len(seen), 1)
            self.assertFalse((root / "smoke.first-key-stop.jsonl").exists())
        with TemporaryDirectory() as tmp:
            ledger = Path(tmp) / "smoke.jsonl"
            record(ledger.with_suffix(".pending"), {"id": self.job["id"], "keySource": PRIMARY}, "xb")
            for _ in range(2):
                self.assertEqual(history(ledger, self.plan)[0]["error"], "aborted_reservation")
            self.assertEqual(len(ledger.read_bytes().splitlines()), 1)

    def test_treatment_transport_and_checker_error(self) -> None:
        jobs = read(CORPUS / "treatment.json")
        job = next(job for job in jobs if job["arm"] == "need-sonnet")
        row = self.tables[0][job["sid"]]
        original = (ARCHIVE / "bodies" / (job["sid"] + ".json")).read_bytes()
        raw = variant(original, row, job["arm"])
        reply = stream("claude-sonnet-5-5", [])
        with endpoint([(200, wire(reply))]) as (connect, seen), patch.dict(os.environ, ANTHROPIC_API_KEY="offline"):
            with patch("send_route_b.grade", side_effect=ValueError):
                result = send(job, row, raw, PRIMARY, connect)
            self.assertEqual(seen[0][2], raw)
            self.assertEqual(result["error"], "checker_error")
            self.assertTrue(result["usageFinal"])
            self.assertEqual(float(result["usd"]), 0.0000994)


if __name__ == "__main__":
    unittest.main()
