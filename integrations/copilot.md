# Hippo + GitHub Copilot

Hippo gives GitHub Copilot memory through three files in Copilot's home folder: a hooks file hippo owns, one `hippo` server in the MCP config, and a short block in the user instructions. The Copilot CLI reads all three, and VS Code's Copilot agent reads the same hooks file.

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

Installing again changes no byte. Start a new chat session after installing, since a running one does not pick up new hooks.

## The hooks

On a machine whose home folder is `/home/you`, `hooks/hippo.json` is:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "type": "command", "bash": "hippo context --pinned-only --include-recent 5 --format copilot", "powershell": "hippo.cmd context --pinned-only --include-recent 5 --format copilot", "timeoutSec": 10 }],
    "postToolUseFailure": [{ "type": "command", "bash": "hippo capture-error --runtime copilot", "powershell": "hippo.cmd capture-error --runtime copilot", "timeoutSec": 10 }],
    "preCompact": [{ "type": "command", "bash": "hippo pre-compact --runtime copilot", "powershell": "hippo.cmd pre-compact --runtime copilot", "timeoutSec": 30 }],
    "sessionEnd": [{ "type": "command", "bash": "hippo session-end --runtime copilot --log-file '/home/you/.hippo/logs/copilot-sleep.log'", "powershell": "hippo.cmd session-end --runtime copilot --log-file '/home/you/.hippo/logs/copilot-sleep.log'", "timeoutSec": 30 }]
  }
}
```

- `sessionStart` loads your pinned memories, plus up to 5 recent ones, into the session as context.
- `postToolUseFailure` stores a failed tool call as an error memory, so the same mistake is easier to avoid next time.
- `preCompact` saves a snapshot of the task before Copilot compacts the conversation.
- `sessionEnd` captures the session and runs `hippo sleep`, logging to `copilot-sleep.log`.

Each hook has a `powershell` form that runs `hippo.cmd`, because on Windows a PowerShell execution policy can block npm's `hippo.ps1`. The log path is written out in full at install time, since PowerShell 5.1 passes `~` to a program as a literal character.

Copilot runs every file in its `hooks` folder, so hippo keeps to its own `hippo.json` and never edits a hooks file of yours.

## The MCP server and the instructions block

Copilot shows the model nothing a hook prints on each prompt, so recall during a task goes through hippo's MCP tools. Setup adds this under `mcpServers` in `mcp-config.json` (with `hippo.cmd` as the command on Windows):

```json
"hippo": { "type": "local", "command": "hippo", "args": ["mcp"], "env": {}, "tools": ["*"] }
```

The instructions block asks the agent to call `hippo_recall` at the start of each task and `hippo_remember` when it learns something that should outlive the session.

Hippo leaves `mcp-config.json` as it is, and prints the entry to add by hand, when the file has comments or is not valid JSON. It also never replaces a `hippo` entry it did not write: one whose command is not `hippo` or `hippo.cmd` with the arguments `["mcp"]`.

## VS Code without the CLI

VS Code reads its MCP servers from its own `mcp.json`, under a `servers` key. To give its Copilot agent the hippo tools, add this to the workspace `.vscode/mcp.json` or to your user `mcp.json`:

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

This removes `hooks/hippo.json`, the `hippo` entry in `mcp-config.json` when hippo wrote it, and the block in `copilot-instructions.md`. Your other hooks files, MCP servers and instructions stay. An instructions file left empty is deleted.

## Status

The install and uninstall steps are covered by `tests/copilot-setup.test.ts`. Hippo has not yet been watched end to end in a live Copilot CLI or VS Code session, so `docs/integrations/agent-inventory.json` keeps Copilot at `planned`.
