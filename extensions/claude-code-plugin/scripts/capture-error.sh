#!/bin/bash
# PostToolUseFailure hook: Claude Code sends the failure as JSON on stdin.
# Interrupts are aborts, not errors worth remembering, so they are skipped.
ERROR_TEXT=$(node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = undefined;
  }
  if (payload === null || typeof payload !== "object") {
    process.stderr.write("hippo: capture-error hook got a payload that is not a JSON object\n");
    return;
  }
  if (payload.is_interrupt || typeof payload.error !== "string") return;
  const text = `${payload.tool_name}: ${payload.error}`.replace(/\s+/g, " ").trim();
  process.stdout.write(text.slice(0, 200));
});
')

if [ -n "$ERROR_TEXT" ]; then
  hippo remember "$ERROR_TEXT" --error --tag auto-captured 2>/dev/null || true
fi
