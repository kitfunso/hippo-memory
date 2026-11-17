"""Writes official.py: MemoryAgentBench's own code, cut by line range from the pinned clone, never retyped.

Stops unless the clone is at PIN and each source file is the commit's blob, so official.py can only hold that code.
Usage (runner venv): python -I vendor_copy.py [--clone ~/hippo-bench/vendor/MemoryAgentBench] [--check]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLONE = Path.home() / "hippo-bench" / "vendor" / "MemoryAgentBench"
PIN = "538026089d1a8a8eff05121d0db89b388f360eba"  # HUST-AI-HYZ/MemoryAgentBench main, 2026-09-25
# (file, first line, last line or None for the end, spaces to dedent); a method dedents to a function with `self`
SEGMENTS = (
    ("utils/eval_other_utils.py", 1, None, 0),  # metrics, parse_output, chunk_text_into_sentences, post_process
    ("utils/templates.py", 1, None, 0),  # system, memorize and query templates, get_template
    ("utils/eval_data_utils.py", 84, 145, 0),  # _process_qa_list_fields and its helpers
    ("conversation_creator.py", 15, None, 0),  # ConversationCreator: query formatting per question
    ("agent.py", 917, 929, 4),  # AgentWrapper._extract_retrieval_query
    ("llm_based_eval/longmem_qa_evaluate.py", 20, 39, 0),  # get_anscheck_prompt
    ("llm_based_eval/summarization_evaluate.py", 19, 329, 0),  # the six judge prompts
    ("llm_based_eval/summarization_evaluate.py", 378, 390, 0),  # parse_json
)
HEAD = ('"""MemoryAgentBench\'s own code, copied by vendor_copy.py from HUST-AI-HYZ/MemoryAgentBench at {pin} (MIT\n'
        'licence); never edit by hand. Each section names its file, its lines and the file\'s git blob."""\n'
        '# ruff: noqa\n# fmt: off\n')


def git(clone: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(clone), *args], capture_output=True, text=True, check=True).stdout.strip()


def build(clone: Path) -> str:
    if git(clone, "rev-parse", "HEAD") != PIN:
        sys.exit(f"{clone} is not at {PIN}; run `git -C {clone} checkout {PIN}`")
    parts = [HEAD.format(pin=PIN)]
    for name, first, last, dedent in SEGMENTS:
        blob = git(clone, "rev-parse", f"HEAD:{name}")
        if git(clone, "hash-object", name) != blob:
            sys.exit(f"{name} in {clone} differs from the pinned commit's blob {blob}")
        lines = (clone / name).read_text(encoding="utf-8").split("\n")
        end = len(lines) if last is None else last
        body = "\n".join(lines[first - 1:end])
        if dedent:
            body = textwrap.dedent(body)
        parts.append(f"\n# ---- {name} lines {first}-{end}, blob {blob} ----\n{body}\n")
    return "".join(parts)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--clone", type=Path, default=CLONE)
    ap.add_argument("--check", action="store_true", help="exit 1 if official.py differs from a fresh copy")
    a = ap.parse_args()
    text, dest = build(a.clone), HERE / "official.py"
    if a.check:
        sys.exit(0 if dest.read_text(encoding="utf-8") == text else f"{dest} differs from {a.clone} at {PIN}")
    dest.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
