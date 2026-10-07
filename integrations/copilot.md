# Hippo + GitHub Copilot

Hippo gives GitHub Copilot memory through a hooks file hippo owns, one `hippo` MCP server and a short set of instructions. The Copilot CLI and VS Code's agent mode read different files, so hippo writes to both:

| Surface | What hippo gives it |
|---------|---------------------|
| Copilot CLI, and Copilot CLI sessions inside VS Code | Session-start context, stored tool failures, a pre-compact snapshot, capture and sleep when the session ends, the MCP server and the instructions block |
| VS Code agent mode (the Local agent) | Session-start context, a pre-compact snapshot, capture after every reply, the MCP server and the instructions file |

VS Code's agent mode has no session-end or tool-failure event. So hippo captures the chat after each reply instead, and stores no tool failures there.

## Install

```bash
hippo setup
```

Setup installs for Copilot when Copilot's home folder exists (`$COPILOT_HOME` when set, else `~/.copilot`), or when VS Code has a User folder. It looks for the Stable (`Code`) and Insiders (`Code - Insiders`) folders under `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, and `$XDG_CONFIG_HOME` or `~/.config` on Linux. `VSCODE_APPDATA` and `VSCODE_PORTABLE` move them, as they do for VS Code. With only VS Code present, setup creates `~/.copilot/hooks`, because VS Code reads its hooks from there too. VS Code reads user hooks from `~/.copilot/hooks` alone, so a `$COPILOT_HOME` set elsewhere does not reach it. To install without the rest of setup:

```bash
hippo hook install copilot
```

Both write:

| File | What hippo puts there |
|------|-----------------------|
| `<copilot home>/hooks/hippo.json` | Six hook entries, in a file hippo owns |
| `<copilot home>/mcp-config.json` | A `hippo` entry under `mcpServers`; every other key stays |
| `<copilot home>/copilot-instructions.md` | A block between `<!-- hippo:start -->` and `<!-- hippo:end -->`; your own text stays |
| `<VS Code User>/mcp.json` | A `hippo` entry under `servers`; every other key stays |
| `<VS Code User>/prompts/hippo.instructions.md` | The same instructions, in a file hippo owns, with `applyTo: "**"` so VS Code attaches them to every chat |

Only the Copilot CLI reads `mcp-config.json` and `copilot-instructions.md`. So setup writes them only when the Copilot home folder held more than `hooks` before setup ran.

Installing again changes no byte, and a `hooks/hippo.json` from an earlier hippo is rewritten to the current table. Start a new chat session after installing, since a running one does not pick up new hooks.

Hippo sets up VS Code's default profile only. When it finds profile folders under `<VS Code User>/profiles`, setup names them. To use hippo in a profile, copy the `hippo` server and `prompts/hippo.instructions.md` into that profile's folder.

## The hooks

`hooks/hippo.json` is the same on every machine:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "hippo context --pinned-only --include-recent 5 --format copilot", "powershell": "hippo.cmd context --pinned-only --include-recent 5 --format copilot", "timeoutSec": 10 }],
    "postToolUseFailure": [{ "type": "command", "bash": "hippo capture-error --runtime copilot", "powershell": "hippo.cmd capture-error --runtime copilot", "timeoutSec": 10 }],
    "preCompact": [{ "type": "command", "bash": "hippo pre-compact --runtime copilot", "powershell": "hippo.cmd pre-compact --runtime copilot", "timeoutSec": 30 }],
    "PreCompact": [{ "type": "command", "bash": "hippo pre-compact --runtime copilot", "powershell": "hippo.cmd pre-compact --runtime copilot", "timeoutSec": 30 }],
    "agentStop": [{ "type": "command", "bash": "hippo session-end --runtime copilot --turn", "powershell": "hippo.cmd session-end --runtime copilot --turn", "timeoutSec": 30 }],
    "sessionEnd": [{ "type": "command", "bash": "hippo session-end --runtime copilot", "powershell": "hippo.cmd session-end --runtime copilot", "timeoutSec": 30 }]
  }
}
```

- `sessionStart` loads your pinned memories, plus up to 5 recent ones, into the session as context. The Copilot CLI and VS Code both fire it.
- `postToolUseFailure` stores a failed tool call as an error memory, so the same mistake is easier to avoid next time. The Copilot CLI only.
- `preCompact` and `PreCompact` save a snapshot of the task before Copilot compacts the conversation. VS Code maps no camelCase `preCompact`, so `PreCompact` is there for it. The Copilot CLI may run both, so `pre-compact` skips a snapshot the same session saved in the last 10 seconds. Copilot has no post-compact hook to close a compaction record, so these save the snapshot alone.
- `agentStop` runs after each reply. VS Code reads it as its `Stop` event, and `--turn` captures the turns since the last reply, as [Capture after each reply](#capture-after-each-reply-in-vs-code) describes. `--turn` acts only on a VS Code payload: snake_case `hook_event_name: "Stop"`, a `.jsonl` transcript path and a session id. The Copilot CLI's `agentStop` sends none of these, so there it does nothing and `sessionEnd` stays the CLI's capture.
- `sessionEnd` captures the session and runs `hippo sleep`. The Copilot CLI only. With no `--log-file`, `session-end --runtime copilot` logs to `~/.hippo/logs/copilot-sleep.log`.

Each hook has a `powershell` form that runs `hippo.cmd`, because on Windows a PowerShell execution policy can block npm's `hippo.ps1`. No command names a path, so nothing in them has to be quoted for bash or PowerShell.

Copilot and VS Code run every file in the `hooks` folder, so hippo keeps to its own `hippo.json` and never edits a hooks file of yours.

## Capture after each reply in VS Code

After each reply, the `agentStop` hook starts a detached worker and exits, so the chat does not wait on capture. The worker:

- reads the chat's transcript, `<VS Code User>/workspaceStorage/<id>/github.copilot-chat/transcripts/<session id>.jsonl`, and captures only the turns after the last reply it read. Its place is kept in `~/.hippo/sessions/<session id>.cursor.json`.
- runs `hippo sleep` only when the store reaches its auto-sleep threshold (`autoSleep.threshold` in the store's `config.json`, 50 new memories by default), and never when `autoSleep.enabled` is false.
- keeps one handoff per chat, rewritten after each reply, and leaves the chat's snapshot open for the next compaction.
- logs to `~/.hippo/logs/copilot-sleep.log`, which starts afresh after each reply.

One worker runs per chat at a time. A reply that lands while one is running is queued for it, so the last reply is never dropped. A worker that died leaves a lock naming its process, and the next reply clears it. Windows reuses process ids, so a lock older than 15 minutes is cleared too.

VS Code says its transcript format is not a stable hook API and can change between releases. If a release changes it, capture and the snapshot can find nothing until hippo is updated. Session-start context and the MCP tools do not read the transcript.

## The MCP server and the instructions

Copilot shows the model nothing a hook prints on each prompt, so recall during a task goes through hippo's MCP tools. Setup adds this under `mcpServers` in `mcp-config.json` (with `hippo.cmd` as the command on Windows):

```json
"hippo": { "type": "local", "command": "hippo", "args": ["mcp"], "env": {}, "tools": ["*"] }
```

VS Code reads its servers from its own `mcp.json`, under a `servers` key. Setup adds this there:

```json
"hippo": { "type": "stdio", "command": "hippo", "args": ["mcp"] }
```

The instructions ask the agent to call `hippo_recall` at the start of each task and `hippo_remember` while it works, whenever it learns something that should outlive the session. In `copilot-instructions.md`, hippo replaces its block only when it holds the exact Copilot text this or an earlier hippo wrote. So a block from an older hippo gets the current text. A block you edited, or another agent's block in the same file, stays as it is, and setup prints one line saying so. A start marker with no end marker leaves the file unchanged, with a line asking you to fix the markers. In VS Code, `prompts/hippo.instructions.md` is written when it is missing or holds an older hippo text. A copy you edited stays.

Hippo leaves an MCP config as it is, and prints the entry to add by hand, when the file has comments or is not valid JSON. VS Code allows comments in `mcp.json`, and hippo does not rewrite a file with comments. When the file cannot be read or written at all, setup prints the system's error and still installs the rest. Hippo also never replaces or removes a `hippo` entry it did not write, and setup prints a line saying so. An entry is hippo's only when it holds just the keys and values setup writes. So one with your own `env`, its own tool list or any other key is yours.

## VS Code versions, Claude Code hooks and exit codes

Hooks need VS Code 1.109.3 or later with `chat.useHooks` on, which is the default. Older versions get the MCP server and the instructions file only. See [VS Code's hooks docs](https://code.visualstudio.com/docs/copilot/customization/hooks).

With `chat.useClaudeHooks` on, which is off by default, VS Code also runs the hooks in `~/.claude/settings.json`. So if you use hippo with Claude Code, its PreCompact hook then fires in VS Code chats too. That hook spots a VS Code transcript path. When `~/.copilot/hooks/hippo.json` exists, it leaves the chat to the Copilot hook and does nothing. Without it, it saves the snapshot alone. It opens no compaction record, since VS Code sends no PostCompact to close one. It prints no instructions for the summariser, since VS Code does not read that text.

VS Code treats exit code 2 from a hook as a blocking error and shows any other non-zero code as a warning. `pre-compact` and `session-end` exit 0 even when they fail, and log why, so they never block a reply or a compaction.

An organisation can switch off MCP servers and hooks for Copilot in VS Code with the `ChatMCP` and `ChatHooks` policies. With those off, neither hippo's tools nor its hooks run, whatever the files say.

## Uninstall

```bash
hippo hook uninstall copilot
```

This removes `hooks/hippo.json`, and the `hippo` entry in `mcp-config.json` when hippo wrote it. It removes the block in `copilot-instructions.md` when that holds a Copilot text this or an earlier hippo wrote. Only the block and one line break next to it go; the rest of the file keeps its bytes, line endings included. An instructions file left with nothing but whitespace is deleted. In each VS Code User folder it removes the `hippo` entry under `servers` when hippo wrote it. It removes `prompts/hippo.instructions.md` when that still holds a hippo text unchanged. Your other hooks files, MCP servers and instructions stay.

Run it before `npm uninstall -g hippo-memory`. The hooks call `hippo`, so once the command is gone each one fails, and VS Code shows a warning after every reply.

## Status

The install and uninstall steps are covered by `tests/copilot-setup.test.ts`, and the hook commands by the other `tests/copilot-*.test.ts` files and `tests/session-worker.test.ts`. Hippo has not yet been watched end to end in a live Copilot CLI or VS Code session. So `docs/integrations/agent-inventory.json` keeps the Copilot CLI at `planned` and marks VS Code agent mode `shipped`: built and covered by fixture tests, not yet verified live.
