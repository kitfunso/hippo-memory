import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import uuid4
from session import CORPUS, child_env, read, write


def grade(folder: Path, row: dict, commands: list) -> int:
    path = folder / ("commands-" + uuid4().hex + ".json")
    write(path, commands)
    env = child_env(folder)
    env["CHECK_COMMANDS"] = str(path)
    result = subprocess.run(["node", str(CORPUS/row["check"]), *row["args"]], env=env,
                            cwd=folder, capture_output=True, timeout=12)
    if result.returncode not in (0, 1, 3):
        raise ValueError("Checker failed")
    return result.returncode


def relocate(value: object, pattern: re.Pattern, cwd: Path) -> object:
    if isinstance(value, str):
        return pattern.sub(lambda _: cwd.as_posix(), value)
    if isinstance(value, dict):
        return {k: relocate(v, pattern, cwd) for k, v in value.items()}
    if isinstance(value, list):
        return [relocate(v, pattern, cwd) for v in value]
    return value


def main() -> None:
    folder = Path(os.environ["REPLAY_FOLDER"])
    row = read(folder/"observer.json")
    event = json.load(sys.stdin)
    data = event["tool_input"]
    if event["hook_event_name"] == "PreToolUse":
        parts = Path(row["original"]).parts[1:]
        separator = r"[\\/]"
        base = separator.join(map(re.escape,parts))
        pattern = re.compile(r"(?:C:|/c)" + separator + base + separator + "runs" + separator
                             + r"[^\\/\s'\";]+" + separator + r"[A-Z0-9]+" + separator + r"seed\d+"
                             + separator + r"work\b", re.I)
        mapped = relocate(data,pattern,folder/"work")
        if mapped != data:
            print(json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse",
                              "permissionDecision":"allow","updatedInput":mapped}}))
    elif grade(folder,row,[data["command"]]) != 3:
        print(json.dumps({"continue":False,"stopReason":"Replay reached the first gradable command."}))


if __name__ == "__main__":
    main()
