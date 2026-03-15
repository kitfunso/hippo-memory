#!/bin/bash
# Auto-capture tool failures as hippo error memories
# Called by PostToolUseFailure hook

# $ARGUMENTS contains the tool failure context from Claude Code
if [ -n "$ARGUMENTS" ]; then
  # Truncate to 200 chars to keep memories concise
  ERROR_TEXT=$(echo "$ARGUMENTS" | head -c 200)
  hippo remember "$ERROR_TEXT" --error --tag auto-captured 2>/dev/null || true
fi
