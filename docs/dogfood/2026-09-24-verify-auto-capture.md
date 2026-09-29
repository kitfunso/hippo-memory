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

## 2. Compaction saves memories?

Needs a hippo that includes the compaction-saves change. Before it, compaction saved only the task snapshot, and a rule stated in the session was not recallable until SessionEnd capture ran. Now `hippo pre-compact` asks the summariser to end its summary with a "Memories for hippo" list, and `hippo post-compact` saves that list as memories.

1. Start `claude` in the project and have a short conversation that states a rule plainly, for example:
   > "Never run npm install here; this repo uses pnpm, because the lockfile is pnpm-lock.yaml."
2. Type `/compact` once. An auto compaction does the same.
3. Check what hippo did, from the project folder:

```bash
# Windows: %USERPROFILE%\.hippo\logs\pre-compact.log
tail -5 ~/.hippo/logs/pre-compact.log
hippo snapshot show            # the task, summary and next step saved at compaction
hippo recall "compaction-memory" --budget 1000
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('.hippo/hippo.db',{readOnly:true});console.log(db.prepare('SELECT status, items_written, started_at FROM compactions ORDER BY started_at DESC LIMIT 3').all())"
hippo doctor
```

**Expect:**
- right after `/compact`, Claude Code shows one line from hippo, such as "Hippo saved 2 memories from this compaction and restored your task snapshot." "Hippo kept this compaction's summary; it listed no new memories." means the summariser wrote no list or listed nothing new. "Hippo will finish saving this compaction at the next sleep." means the store was busy. If no line appears, run `hippo hook install claude-code` (it adds the `PostCompact` hook) and check your Claude Code is recent enough to have that hook;
- the log says `snapshot saved`, and says `no memories section` if the summariser left the list out;
- `snapshot show` prints the task;
- recall lists rows tagged `compaction-memory`, each a standalone sentence, and the rule from step 1 is among them. No `/exit` is needed first;
- the newest compaction record has `status: 'done'` and `items_written` equal to the number in the message. A store with no project `.hippo` uses `~/.hippo/hippo.db`. A record still `started` or `summarised` after 10 minutes shows up as a warning on the `compactions` line of `hippo doctor`; `hippo sleep` finishes it.

A second `/compact` in the same session should list only what is new: an item an earlier compaction already saved is skipped, so the count can be 0. Sleep deletes none of these rows. The session that compacted does not get them injected back into its own prompts; another session in the project does.

**Known limits:** the list comes from the summariser model, so it can be missing or thin, and it has not been measured at a real 250k-token context. Count the `no memories section` log lines over a week. Separately, SessionEnd capture is rule-based, with no AI model, and reads only the last 20 user and 10 assistant turns. A rule phrased as "we use pnpm, never npm, because…" can be missed there. The sandbox run missed exactly that one. SessionEnd fires only when a session ends (`/exit`, `/clear`, logout), so a session left open gets no capture. Whether archiving a session in the VS Code panel fires it is untested. Write down what either path misses.

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
- the newest compaction record's `status` and `items_written`;
- whether recall found the rule and the error.

Put these in `docs/dogfood/` or a PR comment. The roadmap's 90-day queue item "verify automatic capture on the founder's machine" closes when this is done.
