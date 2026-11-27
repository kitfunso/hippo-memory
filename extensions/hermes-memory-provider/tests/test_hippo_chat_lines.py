from __future__ import annotations

from agent.memory_context import build_memory_context_block
from agent.message_metadata import PRE_LLM_BLOCK_WITHHELD_PROMPT, stamp_typed_ask
from agent.prompt_builder import STEER_MARKER_OPEN, steer_user_row
from agent.skill_commands import _build_skill_message
from session_rules.turns import (
    SUMMARY_PREFIX, TODO_INJECTION_HEADER, _MERGED_PRIOR_CONTEXT_HEADER, _MERGED_SUMMARY_DELIMITER,
    _SUMMARY_END_MARKER,
)

from hippo import chat_lines

ASK = {"role": "user", "content": "please fix the deploy script"}
REPLY = {"role": "assistant", "content": "Fixed it."}
SKILL_NOTE = ('[IMPORTANT: The user has invoked the "deploy" skill, indicating they want you to follow its '
              "instructions. The full skill content is loaded below.]")


def texts(rows: list[dict]) -> list[str]:
    return [line["content"] for line in chat_lines(rows)]


def test_a_plain_turn_keeps_the_ask_and_the_reply_only():
    rows = [{"role": "system", "content": "You are Hermes."}, ASK,
            {"role": "tool", "tool_call_id": "c1", "content": "tool output"}, REPLY]
    assert chat_lines(rows) == [{"role": "user", "content": "please fix the deploy script"},
                                {"role": "assistant", "content": "Fixed it."}]


def test_a_background_process_notice_is_dropped():
    notice = "[IMPORTANT: Background process proc_1 finished with exit code 0. Output: build ok]"
    stamped = f"[Tue 2026-11-24 10:00:00 UTC] {notice}"
    assert texts([ASK, {"role": "user", "content": notice}, {"role": "user", "content": stamped}]) == [
        "please fix the deploy script"]


def test_a_todo_snapshot_is_dropped_with_or_without_its_flag():
    snapshot = f"{TODO_INJECTION_HEADER}\n- [ ] ship the fix"
    rows = [{"role": "user", "content": snapshot, "_todo_snapshot_synthetic": True},
            {"role": "user", "content": snapshot}, ASK]
    assert texts(rows) == ["please fix the deploy script"]


def test_a_skill_turn_keeps_the_typed_instruction_and_never_the_body():
    with_ask = _build_skill_message({"content": "SKILL BODY steps", "name": "deploy"}, None, SKILL_NOTE,
                                    user_instruction="ship it today")
    bare = _build_skill_message({"content": "SKILL BODY steps", "name": "deploy"}, None, SKILL_NOTE)
    assert texts([{"role": "user", "content": with_ask}, {"role": "user", "content": bare}]) == ["ship it today"]


def test_a_merged_summary_with_no_flag_keys_keeps_the_carried_ask_only():
    merged = (f"{_MERGED_PRIOR_CONTEXT_HEADER}\nthe carried tail ask\n\n{_MERGED_SUMMARY_DELIMITER}\n\n"
              f"{SUMMARY_PREFIX}\nsummary body words\n\n{_SUMMARY_END_MARKER}")
    standalone = f"{SUMMARY_PREFIX}\nsummary body words\n\n{_SUMMARY_END_MARKER}"
    rows = [{"role": "user", "content": merged}, {"role": "user", "content": standalone},
            {"role": "assistant", "content": merged}, REPLY]
    assert texts(rows) == ["the carried tail ask", "Fixed it."]
    assert not any(key.startswith("_") for row in rows for key in row)


def test_an_image_turn_keeps_the_typed_ask_and_drops_the_memory_block():
    block = build_memory_context_block("- hippo pinned rule: use pnpm in the web repo")
    parts = [{"type": "text", "text": "what is in this picture"},
             {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
             {"type": "text", "text": block}]
    stamped = {"role": "user", "content": parts}
    stamp_typed_ask(stamped, "what is in this picture")
    older = {"role": "user", "content": list(parts)}
    assert texts([stamped, older]) == ["what is in this picture", "what is in this picture"]
    assert "pnpm" not in str(chat_lines([stamped, older]))


def test_a_steer_row_keeps_the_typed_text_and_drops_the_marker():
    steer = steer_user_row("use the staging box instead")
    replayed = {"role": "user", "content": steer["content"]}
    assert texts([ASK, steer, replayed]) == ["please fix the deploy script", "use the staging box instead",
                                             "use the staging box instead"]
    assert STEER_MARKER_OPEN not in str(chat_lines([steer, replayed]))


def test_a_vetoed_prompt_leaves_no_placeholder_line():
    merged = f"an earlier unanswered ask\n\n{PRE_LLM_BLOCK_WITHHELD_PROMPT}"
    rows = [{"role": "user", "content": PRE_LLM_BLOCK_WITHHELD_PROMPT}, {"role": "user", "content": merged}]
    assert texts(rows) == ["an earlier unanswered ask"]


def test_a_gateway_timestamp_and_display_only_rows_are_dropped():
    rows = [{"role": "user", "content": "[Tue 2026-11-24 10:00:00 UTC] what changed?"},
            {"role": "assistant", "content": "This turn did not complete.", "display_kind": "failed_turn"},
            {"role": "user", "content": "a hidden notice", "display_kind": "hidden"}, REPLY]
    assert texts(rows) == ["what changed?", "Fixed it."]
