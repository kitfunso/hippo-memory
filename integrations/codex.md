# Hippo + Codex (OpenAI) Integration

Hippo puts memory into Codex requests through Codex's own [hooks](https://learn.chatgpt.com/docs/hooks). Capture from Codex's `SessionEnd` or `Stop` hook payloads is not tested yet, so session-end consolidation still goes through an opt-in launcher wrapper.

## What the Codex integration does

Hippo's Codex integration does three things:

1. Patches `AGENTS.md` in the current project if it exists, so the agent runs `hippo context` at the start of a task and `hippo remember` when something goes wrong. Without the wrapper, the block also asks for a `hippo capture` summary at session end.
2. Adds two memory hooks to Codex's `hooks.json` (see below), so your pinned memories plus the five most recent ones reach every prompt without the model having to run a command.
3. Only if you opt in, wraps the detected `codex` launcher in place and writes metadata in `~/.hippo/integrations/codex.json`.

## Memory hooks

`hippo hook install codex`, and `hippo setup` when it finds Codex, add these two groups to `$CODEX_HOME/hooks.json`, else `~/.codex/hooks.json`. `hippo init` adds them too when Codex is installed (that folder exists) and the project has `AGENTS.md` or `.codex`; it never creates the folder.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "hippo context --pinned-only --include-recent 5 --format additional-context",
            "commandWindows": "hippo.cmd context --pinned-only --include-recent 5 --format additional-context",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact",
        "hooks": [
          {
            "type": "command",
            "command": "hippo compact-resume",
            "commandWindows": "hippo.cmd compact-resume",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- The `UserPromptSubmit` hook runs the same command as Claude Code's, which sends your pinned memories plus the five most recent ones (`--include-recent 5`). Codex adds its output to the request as developer context and, as with Claude Code, a block that has not changed since the session's last prompt is skipped.
- The `SessionStart` hook runs only when a session starts after a compaction (`matcher` is applied to the start source). It marks the session so the next prompt sends that block again, since the compaction dropped it. Codex gets no `PreCompact` hook from hippo, so nothing saves a task snapshot on the way in; the hook prints one only if it was saved with `hippo snapshot save` in the last 15 minutes, and prints nothing otherwise.
- **Codex asks you to trust each new hook once.** Codex skips a hook it has not reviewed, so open `/hooks` in Codex after installing and trust both. `hippo doctor` reports whether the hooks are in the file, warns when the file is not valid JSON, and repeats this reminder; hippo never writes Codex's trust settings for you.
- What has been seen: the per-prompt hook, run by Codex 0.153.4, put hippo's block into the request Codex sent as developer context. The compaction hook follows Codex's documented `compact` start source and its tests use Codex's payload shape, but it has not been watched end to end in a live Codex session.
- `commandWindows` runs `hippo.cmd`, because Codex runs hooks through PowerShell on Windows, where the execution policy can block npm's `hippo.ps1`.
- Hippo merges into an existing file, keeps every hook that is not its own, and only ever appends. Installing again changes nothing, and hippo never rewrites an entry, since Codex treats a changed command as a new hook to trust. A file that is not valid JSON is left alone with a warning.
- `hippo hook uninstall codex` removes hippo's two exact commands and nothing else: a group of yours that also holds one keeps your handlers, and a hook of yours that runs some other hippo command stays. Codex keys trust to each hook's position in the file, so a hook of yours listed after hippo's may ask to be trusted again.

The wrapper starts the real Codex binary, waits for the session to exit, then spawns a detached Hippo worker that runs:

1. `hippo sleep`
2. `hippo capture --last-session --transcript <codex session file>`

Both commands tee output to `~/.hippo/logs/codex-sleep.log`.

On the next wrapped Codex start, Hippo prints that log via `hippo last-sleep` before launching the real Codex process, so you can see what was consolidated.

## Install and updates

Hippo never wraps Codex on its own (issue #133). `hippo init` and the npm install print the opt-in command when they find Codex. To turn on session capture, run:

```bash
hippo hook install codex
```

It adds the memory hooks too. With no `codex` launcher on `PATH`, it adds the hooks, says so, and leaves capture off.

`hippo setup` also adds the hooks and wraps Codex when it detects it. After you opt in, a Codex update can put the real binary back over the wrapper, so installs, updates and routine Hippo commands re-apply it; they never apply it for the first time. `HIPPO_SKIP_POSTINSTALL=1` stops the re-apply on install and update, `HIPPO_SKIP_AUTO_INTEGRATIONS=1` stops it in routine commands and stops `hippo init` from writing any agent file or hook, the Codex hooks included, and `hippo hook uninstall codex` restores the original launcher and removes the hooks.

Hippo renames the original launcher to a sibling backup such as `codex.hippo-real.cmd` or `codex.hippo-real.exe`, then drops a wrapper at the command path that users already invoke. No extra `PATH` step is required.

## Session source

Hippo captures Codex sessions from the real session transcript files under `~/.codex/sessions/`, not just from `history.jsonl`.

The wrapper records the `history.jsonl` byte offset at launch, finds the new `session_id` written during that run, resolves the matching transcript file in `~/.codex/sessions/...`, and feeds that transcript to `hippo capture --last-session`.

This gives Hippo access to both user messages and assistant responses from the Codex rollout transcript.

## Notes

- This wrapper path is specific to Codex. Claude Code and OpenCode keep using native `SessionStart`/`SessionEnd` hooks.
- The wrapper passes your arguments to Codex unchanged and adds nothing to the prompt, so memory reaches the request once, through the `UserPromptSubmit` hook.
- OpenClaw keeps using the Hippo plugin path, not the Codex wrapper.
- If no local `.hippo/` store exists in the working directory, Hippo cannot consolidate project memory there. Run `hippo init` inside the repo first.
