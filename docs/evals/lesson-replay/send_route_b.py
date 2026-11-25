import argparse
from contextlib import closing
from http.client import HTTPConnection, HTTPException, HTTPSConnection
import json
import msvcrt
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
from typing import Callable
import winreg

from analyze import analyze
from decision_stream import Stop, credit_error, decision, require, usd
from observe import grade
from route_b import ARCHIVE, CORPUS, CORPUS_SEAL, RECEIPTS_SEAL, SONNET, packed, variant
from session import digest, read


PRIMARY = "Z0_CONSOLE_KEY_2"
BACKUP = "Z0_CONSOLE_KEY_3"
HEADERS = {"Content-Type": "application/json", "Accept": "text/event-stream", "anthropic-version": "2023-06-01",
           "anthropic-beta": "context-management-2025-06-27,mid-conversation-output-config-2026-07-01"}


def user_key(name: str) -> None:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
        value = winreg.QueryValueEx(key, name)[0]
    require(isinstance(value, str) and bool(value) and not value.startswith("sk-ant-oat"), "invalid_console_key")
    os.environ["ANTHROPIC_API_KEY"] = value


def post(conn: HTTPConnection, raw: bytes, model: str, receipt: dict) -> list:
    headers = {**HEADERS, "x-api-key": os.environ["ANTHROPIC_API_KEY"]}
    conn.request("POST", "/v1/messages", body=raw, headers=headers)
    with conn.getresponse() as response:
        receipt["http"] = response.status
        if response.status != 200:
            if 400 <= response.status < 500:
                receipt["usd"] = "0"
            try:
                error = json.loads(response.read(65536)).get("error", {})
            except (ValueError, UnicodeError):
                error = {}
            if isinstance(error, dict) and credit_error(error):
                raise Stop("credit_balance")
            raise Stop("http_error")
        require(response.getheader("Content-Type", "").split(";")[0].strip() == "text/event-stream", "invalid_stream")
        return decision(response, model, receipt)


def checked(path: Path, expected: str) -> bytes:
    data = path.read_bytes()
    require(digest(data) == expected, "changed_frozen_input")
    return data


def inputs() -> tuple[dict, dict]:
    seal = json.loads(checked(CORPUS / "seal.json", CORPUS_SEAL))
    for name, expected in seal.items():
        if name.startswith("checks") or name in ("manifest.json", "smoke.json", "gate.json", "treatment.json"):
            checked(CORPUS / name, expected)
    receipts = json.loads(checked(ARCHIVE / "receipts.json", RECEIPTS_SEAL))
    return {r["sid"]: r for r in read(CORPUS / "manifest.json")}, receipts


def record(path: Path, data: dict, mode: str) -> None:
    with path.open(mode) as output:
        output.write(packed(data) + b"\n")
        output.flush()
        os.fsync(output.fileno())


def send(job: dict, row: dict, raw: bytes, key: str, connect: Callable[[], HTTPConnection]) -> dict:
    model = SONNET if job["arm"] == "need-sonnet" else row["model"]
    receipt = {"id": job["id"], "keySource": key, "model": model, "bodySha256": digest(raw),
               "status": "infrastructure_stop", "usage": {}, "usageFinal": False, "usd": None}
    try:
        with closing(connect()) as conn:
            commands = post(conn, raw, model, receipt)
        try:
            with TemporaryDirectory() as folder:
                result = grade(Path(folder), row, commands)
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            raise Stop("checker_error") from error
        receipt.update(status="ok", grade=result, **{"pass": result == 0})
    except Stop as error:
        receipt["error"] = str(error)
    except (OSError, HTTPException, UnicodeError, ValueError, KeyError, TypeError, AttributeError,
            subprocess.SubprocessError) as error:
        receipt["error"] = type(error).__name__
    if receipt["usage"] and receipt["usd"] is None:
        try:
            receipt["usd"] = usd(receipt.get("responseModel", model), receipt["usage"])
        except (KeyError, ValueError, TypeError):
            receipt["usagePriced"] = False
    return receipt


def history(ledger: Path, plan: list) -> list:
    lines = [json.loads(line) for line in ledger.read_bytes().splitlines()] if ledger.exists() else []
    require([r["id"] for r in lines] == [j["id"] for j in plan[:len(lines)]], "ledger_order")
    require(all(r["status"] == "ok" for r in lines[:-1]), "ledger_after_error")
    pending = ledger.with_suffix(".pending")
    if pending.exists():
        reservation = read(pending)
        if not lines or reservation["id"] != lines[-1]["id"]:
            require(len(lines) < len(plan) and reservation["id"] == plan[len(lines)]["id"], "reservation_order")
            entry = dict(reservation, status="infrastructure_stop", error="aborted_reservation",
                         usage={}, usd=None, usageFinal=False)
            record(ledger, entry, "ab")
            lines.append(entry)
        pending.unlink()
    return lines


def credential_stop(rows: list) -> bool:
    if len(rows) != 1 or rows[0]["keySource"] != PRIMARY or rows[0]["status"] != "infrastructure_stop":
        return False
    return rows[0].get("http") in (401, 402) or rows[0].get("error") == "credit_balance"


def phase(name: str, tables: tuple, connect: Callable, load_key: Callable, root: Path) -> bool:
    predecessor = {"gate": "smoke", "treatment": "gate"}.get(name)
    if predecessor:
        require(analyze(predecessor, root / (predecessor + ".jsonl"))["status"] == "PASS", "gate_closed")
    ledger = root / (name + ".jsonl")
    stopped = root / (name + ".first-key-stop.jsonl")
    pending = ledger.with_suffix(".pending")
    plan = read(CORPUS / (name + ".json"))
    manifest, receipts = tables
    while True:
        rows = history(ledger, plan)
        if stopped.exists():
            require(credential_stop([json.loads(line) for line in stopped.read_bytes().splitlines()]), "backup_record")
        key = BACKUP if stopped.exists() else PRIMARY
        require(all(r["keySource"] == key for r in rows), "ledger_key")
        if rows and rows[-1]["status"] != "ok":
            if key == PRIMARY and credential_stop(rows):
                ledger.rename(stopped)
                continue
            return False
        if len(rows) == len(plan):
            return analyze(name, ledger)["status"] in ("PASS", "COMPLETE")
        load_key(key)
        try:
            for job in plan[len(rows):]:
                sid = job["sid"]
                original = checked(ARCHIVE / "bodies" / (sid + ".json"), receipts[sid]["sha256"])
                raw = variant(original, manifest[sid], job["arm"])
                record(pending, {"id": job["id"], "keySource": key}, "xb")
                entry = send(job, manifest[sid], raw, key, connect)
                record(ledger, entry, "ab")
                pending.unlink()
                print(job["id"], entry["status"], flush=True)
                if entry["status"] != "ok":
                    break
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)


def live() -> HTTPSConnection:
    return HTTPSConnection("api.anthropic.com", timeout=600)


def main() -> bool:
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["smoke", "gate", "treatment", "full"])
    name = parser.parse_args().phase
    with (ARCHIVE / "sender.lock").open("a+b") as lock:
        lock.seek(0)
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        tables = inputs()
        phases = ("gate", "treatment") if name == "full" else (name,)
        return all(phase(part, tables, live, user_key, ARCHIVE) for part in phases)


if __name__ == "__main__":
    raise SystemExit(0 if main() else 1)
