# Verify automatic capture on your own machine

**Why:** automatic capture only runs if the hooks are actually installed where Claude Code reads them. A real `/compact` in a sandbox on 2026-09-24 confirmed the mechanism. Your machine has not been checked. An older install, or a project without `CLAUDE.md`, can be missing hooks.

Run these in a project where you use Claude Code (PowerShell or a terminal). Hippo must include the 2026-09-24 changes (PR #227).

## 1. Hooks installed?

```bash
hippo doctor
```

The `claude-code` line should read "all hippo hooks installed, including compaction and failed-tool capture" or "hippo plugin enabled". If it lists missing hooks, run:

```bash
hippo hook install claude-code
```

This adds only what is missing, and is safe to re-run.

## 2. Compaction snapshot works?

**Changed 2026-09-26 (#258):** compaction now saves only the task snapshot. It no longer saves memories, so the rule below is not recallable until the session ends and SessionEnd capture runs. Saving memories at every compaction is being rebuilt; see ROADMAP Track Z, "Pre-compact audit".

1. Start `claude` in the project and have a short conversation that states a rule plainly, for example:
   > "Never run npm install here; this repo uses pnpm."
2. Type `/compact`.
3. Check what hippo did:

```bash
# Windows: %USERPROFILE%\.hippo\logs\pre-compact.log
tail -5 ~/.hippo/logs/pre-compact.log
hippo snapshot show            # the task, summary and next step saved at compaction
hippo recall "pnpm npm install" --budget 500
```

**Expect:**
- right after `/compact`, Claude Code shows "Hippo saved your task snapshot … before compacting". If it does not appear, run `hippo hook install claude-code` (it adds the `PostCompact` hook) and check your Claude Code is recent enough to have that hook;
- the log says `snapshot saved`;
- `snapshot show` prints the task;
- recall does not find the rule yet. Close the session with `/exit`, then run the recall again: SessionEnd capture should have stored it. SessionEnd fires only when a session ends (`/exit`, `/clear`, logout), so a session left open gets no capture. Whether archiving a session in the VS Code panel fires it is untested.

**Known limit:** capture is rule-based, with no AI model, and reads only the last 20 user and 10 assistant turns. A rule phrased as "we use pnpm, never npm, because…" can be missed. The sandbox run missed exactly that one. Write down what it misses.

## 3. Failed-tool capture works?

In Claude Code, ask the agent to run a command that fails for a real reason, for example a build with a missing module. Then:

```bash
hippo recall "Cannot find module" --budget 500
```

The failure should be stored once, tagged `error` and `auto-captured`.

It should **not** be stored when:
- you interrupt the agent;
- you decline a permission;
- a search finds nothing.

## 4. Report back

Record:
- what `hippo doctor` said;
- the last lines of `pre-compact.log`;
- whether recall found the rule and the error.

Put these in `docs/dogfood/` or a PR comment. The roadmap's 90-day queue item "verify automatic capture on the founder's machine" closes when this is done.
