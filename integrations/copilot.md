# Hippo + GitHub Copilot

Hippo gives GitHub Copilot memory through three files in Copilot's home folder: a hooks file hippo owns, one `hippo` server in the MCP config, and a short block in the user instructions. What each Copilot surface gets from them differs:

| Surface | What hippo gives it |
|---------|---------------------|
| Copilot CLI, and Copilot CLI sessions inside VS Code | All four hooks, the MCP server and the instructions block |
| VS Code's Local agent | Session-start context only, for now |

VS Code's Local agent skips the `preCompact` name in a Copilot hooks file, has no session-end or tool-failure event, and does not read `copilot-instructions.md` or `mcp-config.json`. So it gets no pre-compact snapshot, no end-of-session capture and no stored tool failures yet. For hippo's recall tools there, add hippo to VS Code's own `mcp.json`, as [VS Code's Local agent](#vs-codes-local-agent) shows.

## Install

```bash
hippo setup
```

Setup installs for Copilot only when its home folder exists: `$COPILOT_HOME` when set, else `~/.copilot`. It never creates that folder. To install without the rest of setup, or before Copilot has made its folder:

```bash
hippo hook install copilot
```

Both write:

| File | What hippo puts there |
|------|-----------------------|
| `<copilot home>/hooks/hippo.json` | Four hooks, in a file hippo owns |
| `<copilot home>/mcp-config.json` | A `hippo` entry under `mcpServers`; every other key stays |
| `<copilot home>/copilot-instructions.md` | A block between `<!-- hippo:start -->` and `<!-- hippo:end -->`; your own text stays |

Installing again changes no byte, and a `hooks/hippo.json` from an earlier hippo is rewritten to the current table. Start a new chat session after installing, since a running one does not pick up new hooks.

## The hooks

`hooks/hippo.json` is the same on every machine:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "hippo context --pinned-only --include-recent 5 --format copilot", "powershell": "hippo.cmd context --pinned-only --include-recent 5 --format copilot", "timeoutSec": 10 }],
    "postToolUseFailure": [{ "type": "command", "bash": "hippo capture-error --runtime copilot", "powershell": "hippo.cmd capture-error --runtime copilot", "timeoutSec": 10 }],
    "preCompact": [{ "type": "command", "bash": "hippo pre-compact --runtime copilot", "powershell": "hippo.cmd pre-compact --runtime copilot", "timeoutSec": 30 }],
    "sessionEnd": [{ "type": "command", "bash": "hippo session-end --runtime copilot", "powershell": "hippo.cmd session-end --runtime copilot", "timeoutSec": 30 }]
  }
}
```

- `sessionStart` loads your pinned memories, plus up to 5 recent ones, into the session as context. The Copilot CLI and VS Code's Local agent both fire it.
- `postToolUseFailure` stores a failed tool call as an error memory, so the same mistake is easier to avoid next time. The Copilot CLI only.
- `preCompact` saves a snapshot of the task before Copilot compacts the conversation. The Copilot CLI only: VS Code reads no `preCompact` entry from a Copilot hooks file.
- `sessionEnd` captures the session and runs `hippo sleep`. The Copilot CLI only. With no `--log-file`, `session-end --runtime copilot` logs to `~/.hippo/logs/copilot-sleep.log`.

Each hook has a `powershell` form that runs `hippo.cmd`, because on Windows a PowerShell execution policy can block npm's `hippo.ps1`. No command names a path, so nothing in them has to be quoted for bash or PowerShell.

Copilot runs every file in its `hooks` folder, so hippo keeps to its own `hippo.json` and never edits a hooks file of yours.

## The MCP server and the instructions block

Copilot shows the model nothing a hook prints on each prompt, so recall during a task goes through hippo's MCP tools. Setup adds this under `mcpServers` in `mcp-config.json` (with `hippo.cmd` as the command on Windows):

```json
"hippo": { "type": "local", "command": "hippo", "args": ["mcp"], "env": {}, "tools": ["*"] }
```

The instructions block asks the agent to call `hippo_recall` at the start of each task and `hippo_remember` when it learns something that should outlive the session. Hippo replaces the block only when it holds the exact Copilot text hippo wrote. A block you edited, or another agent's block in the same file, stays as it is, and setup prints one line saying so. A start marker with no end marker leaves the file unchanged, with a line asking you to fix the markers.

Hippo leaves `mcp-config.json` as it is, and prints the entry to add by hand, when the file has comments or is not valid JSON. When the file cannot be read or written at all, setup prints the system's error and still installs the hooks and the block. Hippo also never replaces a `hippo` entry it did not write: one whose command is not `hippo` or `hippo.cmd` with the arguments `["mcp"]`.

## VS Code's Local agent

VS Code's Local agent runs only the `sessionStart` hook from `hooks/hippo.json`. VS Code skips the `preCompact` name in a Copilot hooks file, and it has no session-end or tool-failure event, so neither the pre-compact snapshot nor end-of-session capture runs there yet. It also reads neither `copilot-instructions.md` nor `mcp-config.json`.

VS Code reads its MCP servers from its own `mcp.json`, under a `servers` key. To give the Local agent the hippo recall tools, add this to the workspace `.vscode/mcp.json` or to your user `mcp.json`:

```json
{
  "servers": {
    "hippo": {
      "type": "stdio",
      "command": "hippo",
      "args": ["mcp"]
    }
  }
}
```

An organisation can switch off MCP servers and hooks for Copilot in VS Code with the `ChatMCP` and `ChatHooks` policies. With those off, neither hippo's tools nor its hooks run, whatever the files say.

## Uninstall

```bash
hippo hook uninstall copilot
```

This removes `hooks/hippo.json`, the `hippo` entry in `mcp-config.json` when hippo wrote it, and the block in `copilot-instructions.md` when it holds the Copilot text hippo wrote. Only the block and one line break next to it go; the rest of the file keeps its bytes, line endings included. Your other hooks files, MCP servers and instructions stay. An instructions file left with nothing but whitespace is deleted.

## Status

The install and uninstall steps are covered by `tests/copilot-setup.test.ts`, and the hook commands by the other `tests/copilot-*.test.ts` files. Hippo has not yet been watched end to end in a live Copilot CLI or VS Code session, so `docs/integrations/agent-inventory.json` keeps both the Copilot CLI and VS Code's Local agent at `planned`.
