# Phase A0 Spike — SessionStart hook payload shape

## Question
Does Claude Code pass the active `model` to the SessionStart hook via stdin? If not, the whole Phase B auto-detection needs a different approach.

## Method
1. Inspected `~/.claude/scripts/hooks/session-end.js` to see what fields Claude Code's existing Stop hook reads.
2. Inspected `src/cli.ts:1498-1519` (hippo's `session-end` handler) to confirm the payload shape in production.
3. Read a real transcript JSONL at `~/.claude/projects/C--Users-skf-s-hippo/a0f143ad-cb25-424c-a956-66d9ee09074e.jsonl`.

## Findings

**1. Hook stdin payload carries `transcript_path`, NOT `model` directly.**

The hippo session-end handler parses only `payload.transcript_path` (cli.ts:1512). This is the standard Claude Code hook protocol. The payload also carries `session_id` and `source` (`"startup"` / `"clear"` / `"compact"`) based on existing Anthropic docs.

**2. Model info lives inside the transcript JSONL.**

Grepping the transcript finds entries with `"model":"claude-haiku-4-5-20251001"` on every assistant message. Format is the full versioned model id (date-suffixed).

**3. Model is NOT known at SessionStart.**

Transcript order:
```
queue-operation (user input) → hook_success SessionStart:startup → attachment → user → message (has model)
```

The SessionStart hook fires BEFORE the first model call, so the transcript won't contain a `model` field at that instant. The model is only revealed after the first turn (and may change mid-session via `/model`).

## Implication for Phase B

The original plan ("capture model at SessionStart, store in session-state.json, read at context time") won't work as-is. Revised design:

1. **SessionStart hook** writes `~/.hippo/sessions/<session_id>.json` with `{sessionId, transcriptPath}` — no model yet.
2. **`detectModel(root)`** reads the newest session-state file, then tails the referenced transcript JSONL (last ~10 KB) to find the most recent `"model":"..."` line. Returns the normalized model id.
3. **Normalization:** strip trailing date suffix (`-\d{8}$`) so `claude-haiku-4-5-20251001` → `claude-haiku-4-5` for profile table lookup.
4. **SessionEnd hook** clears the session-state file for that `session_id`.

Benefits of this revision:
- Works even though the hook doesn't pass `model` directly.
- Picks up `/model` switches mid-session automatically.
- Gracefully degrades: if transcript is missing, detection returns `undefined` and we use the default profile.

Cost: one small file-tail per `hippo context --auto` call. Negligible.

## Decision

**PROCEED to Phase A1** with the revised detection design above. Update Plan Task B3 (model-detector) to tail the transcript instead of reading `state.model` directly.

## Evidence snippets

From the transcript (`~/.claude/projects/C--Users-skf-s-hippo/a0f143ad-cb25-424c-a956-66d9ee09074e.jsonl`):

```json
{"type":"queue-operation","sessionId":"a0f143ad-...","content":"what is 2+2\n"}
{"type":"hook_success","hookName":"SessionStart:startup","hookEvent":"SessionStart"}
...
{"type":"message","model":"claude-haiku-4-5-20251001",...}
```

From `src/cli.ts:1512`:
```ts
if (typeof payload.transcript_path === 'string') {
  transcriptPath = payload.transcript_path;
}
```

Hippo already reads `transcript_path` in production. Extension is cheap.
