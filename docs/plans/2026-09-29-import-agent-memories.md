# Plan: hippo imports the agent memories a user already has

Rev 4 (plan-eng reviews r1 and r2 applied, see Review log). Status: building. Branch `feat/import-agent-memories`,
rebased onto 34f165f (compaction PR 1, which brought the keep rule and the gated write).

Goal (Keith, verbatim): "build this for hippo imports reads the user's current agent memories please(agnostic of
what tool)". On install and at every sleep and session end, hippo reads the memories each coding agent on the machine
already keeps, whatever the tool, and holds them as hippo memories that follow the note: kept while the note exists,
replaced when it changes, set aside (restorable) when it goes.

This takes over PR 2 of the compaction plan (the Claude Code note sync) and widens it to every agent. Every PR 2 rule
and test is kept, the session-end import for folders without a store included; the differences are listed under
"Changes from compaction PR 2".

## Evidence (what hippo does today)
- `hippo init` imports the project's Claude Code auto memory once, on first init only (cli.ts:776-793, via
  `learnFromMemoryMd`, cli.ts:2906). `hippo sleep` repeats it (cli.ts:3189).
- It reads `~/.claude/projects/<folder>/memory/*.md` under `os.homedir()` only. An `autoMemoryDirectory` setting,
  `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_PROJECT_DIR_NAME` imports nothing (the SHORTCUT at cli.ts:2908).
- Dedupe is by text: a note edited after import becomes a second row and the old one stays, both live. A deleted
  note's row stays. Rows keep `source: claude-memory:<file>`, with no folder, so two projects' `feedback.md` collide.
- Session end sleeps only a folder that has its own store (Claude cli.ts:3451-3460, Codex cli.ts:3716-3723), so a user
  on the global store alone never imports at session end.
- `hippo init --scan` learns git history only (cli.ts:665-733). `hippo setup` imports nothing. `init --global` returns
  early when the global store exists (cli.ts:745-748).
- Nothing reads Codex, Gemini CLI or any other agent's memories. `hippo import --claude/--cursor/--chatgpt/--markdown`
  import an instruction file or an export once, by hand (importers.ts:254-536); `--vault` syncs a folder of notes as
  raw receipts, by hand (importers.ts:734).

## Design

1. **One sync, many adapters.** An adapter knows one tool: where its memory lives and how to read it. It returns
   containers (a folder, or a section of a file), each `readable` or not, with items `{ key, text, updatedAt }` and
   the keys of files it found but could not read (`skipped`). The sync knows no tool: it owns keys, change
   detection, supersede, set-aside, secrets, store routing and counts. New files, one concern each:
   - `src/agent-memories/tools.ts`: a leaf module (no imports) listing each tool's id and tag. memory.ts
     (`KEEP_PAIRS`) and shared.ts (`NO_MERGE_TAGS`, `NEVER_AUTO_SHARE_TAGS`) read it, so the lists cannot drift.
   - `src/agent-memories/claude-code.ts`, `codex.ts`, `gemini.ts`, `copilot.ts`, `openclaw.ts`, `qwen-code.ts`: the
     adapters (see Adapters). Each takes `{ home, env, platform, projectRoot }` and reads nothing else from the
     process, so tests never touch `process.env`. `claudeMemoryFolderNames` (taking `platform`), `claudeCheckoutRoot`
     and `claudeFolderName` move here from cli.ts; `codexHomeDir` (hooks.ts:221) gains an `env` parameter.
   - `src/agent-memories/markdown.ts` (built): splits one markdown file into items (top-level bullets with their
     sub-lines, and paragraphs), each with its nearest heading. `keys.ts` holds the hashes and single-file keys, and
     `files.ts` and `git.ts` the shared reads.
   - `src/agent-memories/plan.ts`: a pure function from (a container's items, the live and dormant rows for its keys)
     to actions. The state matrix is tested here without a store.
   - `src/agent-memories/sync.ts`: runs the adapters, applies each container's actions in one transaction, mirrors
     after commit, and returns counts.
   `learnFromMemoryMd` is deleted with its callers moved (no shim; it is not exported from index.ts).

2. **Where rows land.**
   - Project pass: the project containers of one project root go to that project's store.
   - User pass: a tool's global memory goes to the global store, created on demand as capture, share and MCP first
     run do (`initGlobal`, shared.ts:44), with `origin_project = ''`.
   - A sync of the global store itself (a `hippo sleep` with no local store, the daily runner on the global store)
     runs the user pass only. A project pass rooted at home would match every workspace on the machine.
   - Session end in a folder without a store runs the project pass for the session's own project (the cwd's
     project, project-identity.ts) into the global store, with `origin_project` set to that project, plus the user
     pass. For Claude Code the transcript's own folder, `dirname(transcript_path)/memory/`, is one of its
     containers. This is PR 2's hook rule. A store-less folder outside any git repository resolves to home with the
     name '' (project-identity.ts:117-118), so its notes land as user-global, as hippo files that folder's captures.
   - Post-compact reads only the transcript folder's container, after PR 1's own write, into the folder's store or
     the global store by the same rule: no sleep, no git call, no legacy adoption, no user pass. PR 1's hook has a
     10-second limit, and PR 2 kept git and adoption off it for that reason.
   - Handover: when a project pass into a local store commits, the global store's tagged rows under the containers
     that pass read, and under the project's own origin (`deriveOriginProject` of the store's folder, what
     post-compact stamps) or under origin `''` (a folder with no git and no marker has no origin until its store
     exists), are set aside (design 6). Rows of a note the pass could not read stay until it can.
     Without this, rows the hook path wrote before the project had a store would stay kept and be served beside the
     local copy after the note is deleted.

3. **Row shape.** `kind: 'distilled'`, `layer: Episodic`, `confidence: 'observed'`, one tag per tool
   (`claude-code-memory` stays; `codex-memory`, `gemini-memory`, ...), and
   `source: agent-memory:<tool>:<container>/<item>#<hash>`.
   - `<hash>`: the first 16 hex characters of the sha256 of the item's full text with CRLF folded to LF, so an edit
     past the 1500-character content cap is still seen. It lives in `source` because recall prints tags (cli.ts:589)
     and, with `--why`, `artifact_ref` (cli.ts:599), and context prints tags (context-render.ts:67); none prints
     `source`.
   - `<container>`: `p-` (project) or `u-` (user) plus the first 12 hex of the sha256 of the container's real path
     (`fs.realpathSync.native`, falling back to `path.resolve` as `realpathOrResolve` does in project-identity.ts),
     with `/` separators and lowercased on win32. Fixed length, never a `/`, never a user path, and two config
     folders with the same project folder name stay apart. A project pass into the global store hashes the origin
     in too: a linked worktree shares its main checkout's Claude folder but not its origin, so each gets its own rows
     and recall in either one sees the note.
   - `<item>`: the item's path inside the container with `/` separators; for a single-file store,
     `<heading slug>/<first 12 hex of the item text's sha256>`, with `~2`, `~3` added to repeats of the same text
     under the same heading.
   - No new table.

4. **Content.** The item's text with email addresses masked, as every capture path does, then cut at 1500 characters
   plus ` [truncated]` (the cap is unchanged; see Out of scope). The source hash is taken on the raw note text.
   Refused and counted: text under 10 characters after trim, a secret (any text `redactSecretsStrict` would change,
   Bearer and Basic headers, JWTs and PEM blocks included, since imported rows reach prompts), and a rejected value (looked
   up with `findRejectedValue`, rejection.ts:108, on the text as stored, after the cap, before writing, so a rejected
   note writes no audit row at every sync). A refused item is present with a hash that cannot be written (design 6).
   Writes go through PR 1's `gatedWrite` with `worthCheck: false`: that check drops short text with no number or
   proper noun, which is exactly a one-line preference bullet. The secret veto, origin stamp and rejection audit stay
   on. The hook case's origin needs no option: the sync sets `origin_project` on the entry and stampOriginProject
   keeps a preset origin (store.ts:1591). For Claude notes the frontmatter is still required and `MEMORY.md` still
   skipped.

5. **Time.** `created` and `valid_from` take the item's own time (frontmatter `modified`, else file mtime) when it is
   earlier than now, written as `new Date(t).toISOString()` (the loader treats any other form as drift,
   store.ts:2335-2344); `last_retrieved` stays now. Strength and the aged label read `last_retrieved`
   (memory.ts:329-331, 448-451). `created` also feeds recall's recency multiplier (up to 20% lower for an old note,
   search.ts:121-122, 610), `temporalBoost` (search.ts:174), the recent-N context order (api.ts:2887) and the
   "Previously observed (date)" line (context-render.ts:73). Accepted: the note's age is its true age, and a first
   import of 200 notes no longer takes every recent slot.

6. **The state matrix** (per item key, within one container; plan.ts). "Tagged" is a live row with the key's source
   and the tool tag. "Untagged" is a live row with the key's source and no tag: a set-aside row the user restored,
   or a pinned row whose note went. "Dormant" is a readable `dormant_memories` snapshot with the key's source and no
   `superseded_by`. A row's hash is the one in its source. An item is **present** (read, with its hash), **refused**
   (read, but short, a secret or rejected: design 4), **unread** (in `skipped`: empty, over 256 KB, a NUL byte, a
   failed read) or **gone**.
   - present, a live row has its hash: that row is kept (the newest such tagged row by `created`, then id; else an
     untagged one, whose tag goes back on with its id and recall history). Every other tagged row of the key is
     superseded by it. Untagged rows with another hash are left alone, so a `hippo dormant restore` survives.
   - present, no live row has its hash, some live row exists: write the new row and set `superseded_by` on every
     live row of the key, tagged and untagged (the note changed after any restore), in the container's transaction
     (the api.supersede pattern, api.ts:2092-2128). The note is the source.
   - present, no live row: the newest dormant snapshot with its hash comes back with its tag (a deleted note came
     back). This is the sync's own restore with its own audit op, not `dormant_restore`, which marks "forgot it, then
     needed it" for ROADMAP LC3 (api.ts:3321-3335). No such snapshot: write a row; other snapshots stay until
     retention purges them.
   - refused: nothing written; every tagged row of the key is set aside, since the note no longer says what the row
     says.
   - unread: nothing for its key.
   - gone, container readable: every tagged row is set aside. Untagged rows: nothing; the user restored them on
     purpose.
   - **Set aside**, on the container's handle and in its transaction: (1) UPDATE the tool tag off; (2)
     insertDormantRow with reason `source-deleted`; (3) DELETE from `memories` and FTS and mark dirty DAG parents, as
     sleep does (store.ts:2216-2228), but without sleep's `AUTO_DELETABLE_SQL` filter, which skips exactly these rows;
     (4) after commit, purge the mirror (removeEntryMirrors, store.ts:1030), since a mirror left on disk comes back
     through rebuildIndex (store.ts:2481-2484). A pinned row loses its tag and stays live, counted. A set-aside row
     stops reaching recall and context at once; `hippo dormant` lists it with its reason, `hippo dormant restore`
     brings it back and `retentionDays` purges it. Set-asides go to dormant even with `dormant.enabled: false`. A
     note deleted as wrong is never served again; with plain decay it would be served for years
     (`DEFAULT_HALF_LIFE_DAYS = 365`, memory.ts:491).
   - container unreadable, missing or busy: nothing for any of its keys.
   - a container the adapter no longer lists (a moved repository, an uninstalled tool, another config folder): its
     rows are left as they are, apart from the handover in design 2. Keeping what an old tool knew is part of the
     point; a false set-aside after a git timeout or a different environment would be worse than a stale keep.
   - single-file stores key an item by its text. When one sync finds exactly one key gone and exactly one new key
     under the same heading, that is an edit: the new row supersedes the old. Any other mix is set-asides plus new
     rows.
   - text already stored live by another path (a remember, a capture): skipped and counted, as today. Rows whose source
     starts `agent-memory:` do not count, so each tool's copy is tracked apart and deleting it in one tool sets aside
     only that copy. In the global store only rows visible where the new row goes count (origin '' or the new row's
     own origin): a row from project Y would otherwise hide the note from every other project. Checked after legacy
     adoption.
   - the user superseded an imported row (`hippo supersede`): api.supersede copies tags and source to the new row
     (api.ts:2081-2090), so the user's text becomes the key's tagged row with the same hash, left alone until the note
     changes.
   - forgotten row (`hippo forget`): imported again while the item exists, as today. `hippo reject` stops it for good.
   - a superseded row is not kept: PR 1's keep rule stops at `superseded_by` (204b332).

7. **Lookup.** From `memories`: rows where `tenant_id = ?`, `superseded_by` is null and `source` starts with
   `agent-memory:<tool>:<container>/` (LIKE with ESCAPE, as importVault does, importers.ts:820), bucketed by key
   (everything before the last `#`) as importVault buckets, importers.ts:807-810. Loaded once per container. From
   `dormant_memories` only when some present item's key has no live row (after the first import, usually none): the
   same prefix on `CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.source') END`, so one malformed
   snapshot is passed over rather than failing every sync. No `loadAllEntries`.

8. **Concurrency.** Lookup and every write for one container run in one `BEGIN IMMEDIATE` on one handle, through
   `gatedWrite` on that handle. Transactions never nest: a process holds one store's transaction at a time, and the
   project pass commits before the user pass opens the global store. `SQLITE_BUSY` after the busy timeout (db.ts:2597)
   skips that container with one warning and nothing set aside; sleep goes on. Every changed row (written,
   superseded, re-tagged, restored) is mirrored after commit; a set-aside row's mirror is purged.

9. **Keep rule, merge and sharing.** From tools.ts: one `KEEP_PAIRS` entry per tool (its tag plus
   `agent-memory:<tool>:`), each tool tag in `NO_MERGE_TAGS` and in `NEVER_AUTO_SHARE_TAGS`. Auto-share
   (shared.ts:551) and `syncGlobalToLocal` (shared.ts:645-656) also skip `agent-memory:` sources, so a restored,
   untagged row does not travel either, and a user-pass row is never copied into a project store where no pass would
   ever set it aside. An imported row is kept as written: never merged, never sent to LLM extraction, never
   auto-shared, never auto-deleted while its item exists.

10. **Legacy rows** (`source: claude-memory:<file>`, tag `claude-code-memory`, written by `learnFromMemoryMd`) are
    adopted at init and sleep, for the store's own Claude folders only, in two rounds across all of them:
    - first, same text as any current note (so a renamed note is caught): `UPDATE` its source to the new key, keeping
      its id, recall count and outcomes;
    - then, different text and exactly one live legacy row of that file name: superseded by the new row;
    - otherwise untouched. `claude-memory:` is not a keep prefix, so unadopted legacy rows decay as they do today.

11. **Call sites.** Each returns counts and never prints; the command prints one line when anything moved, for
    example "Imported 12 agent memories (Claude Code 10, Codex 2); 1 replaced, 1 set aside, 1 skipped for a secret."
    - `hippo init`: every run, the import moved out of the first-init block (cli.ts:777); project pass, then user
      pass. `--global`: the user pass, before the early return (cli.ts:745-748).
    - `hippo init --scan`: each repo's project pass, then the user pass once.
    - `hippo setup`: the user pass.
    - `hippo sleep`: a local store gets its project pass and the user pass; the global store gets the user pass only.
    - Session end (Claude and Codex): through sleep when the folder has a store; otherwise directly, as design 2 says.
    - Post-compact (PR 1's hook, merged): the transcript folder's container only, after PR 1's own write (design 2).
    - `hippo import --agents [--dry-run]`: runs the import by hand, in a folder without a store as session end does
      there. `--dry-run` writes nothing and prints each tool's
      resolved home, its containers, what would be written, replaced and set aside, and how many kept rows sit in
      containers not listed this run (a moved project's old copy). Z0's stage 0 check uses it.
    - Opt out: `--no-learn` (init, sleep) as today; config `agentMemories.tools`, a list of tool ids (default every
      tool, `[]` turns the import off); and the environment variable `HIPPO_AGENT_MEMORY_TOOLS` (comma-separated
      ids, empty or `none` for off), which overrides config. Without the variable a pass runs only the tools that
      both the invoking store and the target store allow, so `[]` in a project store also stops that project's
      sleeps writing the user pass into the global store. The variable exists because config is per store and `hippo
      init` creates the store in the same command that imports.

12. **Reading another tool's store.** Files only, read and never written; no adapter opens another tool's database.
    An empty file (a tool rewriting a file truncates it first), a file over 256 KB, a file holding a NUL byte, or a
    failed read is unread (design 6): its rows are left alone. An
    unreadable folder or a single-file store whose shape check fails marks the container unreadable: one warning
    line, nothing set aside, and the sync goes on. A failed git call only lists fewer containers, which changes
    nothing (design 6). The old bare catch (cli.ts:2976) goes.

13. **Tool homes.** Each adapter resolves its home the way its tool does (environment variables, then settings, then
    the default), never a hard-coded `~/.tool`. Z0's stage 0 gives every run its own `CLAUDE_CONFIG_DIR` and
    `CODEX_HOME` (planned there, not yet in the runner) and sets `HIPPO_AGENT_MEMORY_TOOLS=claude-code,codex` in each
    run's environment, which its hooks inherit.

## Adapters
Every fact below is checked against the tool's own docs or source (see Research). "Home" is the injected home unless a
tool's variable replaces it. Items are stored as their body text (frontmatter stripped where a tool writes it), with
the file's mtime as the item time unless a better one is named.

**Claude Code** (`claude-code`, tag `claude-code-memory`).
- Config folder: `CLAUDE_CONFIG_DIR`, else `<home>/.claude`.
- Project containers: `<config>/projects/<name>/memory/` for each name `claudeMemoryFolderNames` gives the project
  root (unchanged rules); `<config>/projects/$CLAUDE_CODE_PROJECT_DIR_NAME/memory/` when `CLAUDE_CONFIG_DIR` is also
  set and the name is 1-64 of `[A-Za-z0-9_-]`; at a hook, `dirname(transcript_path)/memory/`. When the git call
  fails fewer folders are listed (design 12).
- User container: `autoMemoryDirectory` from `<config>/settings.json` (absolute, or `~/` expanded against home).
  Claude does not say it makes per-project folders under it, so every project shares it and it goes to the global
  store.
- Items: `*.md` directly in the folder except `MEMORY.md`, frontmatter required, body of 10 characters or more (as
  today). Item time: frontmatter `modified` when it parses as a date, else mtime.
- Not read: `autoMemoryDirectory` from project or local settings (Claude honours those only for a trusted folder, and a
  cloned repository's committed settings could point the import at another project's notes), managed settings and
  `--settings` files. The off switches (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `autoMemoryEnabled: false`) stop Claude
  writing; notes already on disk are still imported, and `agentMemories.tools` covers the rest.

**Codex CLI** (`codex`, tag `codex-memory`).
- Home: `codexHomeDir(home, env)` (`CODEX_HOME`, else `<home>/.codex`).
- User container: `<codex home>/memories/memory_summary.md`, the only memory file Codex puts in its prompt.
  Shape check: the first non-empty line is `v1` and a `## User Profile` heading exists.
- Items: the paragraphs and top-level bullets (sub-lines stay with their bullet) under `## User Profile`,
  `## User preferences` and `## General Tips`, all of which Codex puts in its prompt. Stored as `<heading>: <item>`. `## What's in Memory` is an index into `MEMORY.md` and is skipped.
- Not read: `MEMORY.md` (a registry Codex greps on demand, grouped by working folder), `raw_memories.md`,
  `rollout_summaries/`, `memories_1.sqlite`, and the v2 pipeline (opt-in, layout not checked).

**Gemini CLI** (`gemini`, tag `gemini-memory`). Gemini folder: `<GEMINI_CLI_HOME or home>/.gemini`.
- User container: the `## Gemini Added Memories` section of `<gemini folder>/GEMINI.md` (written by `save_memory`
  up to v0.43; existing users still have it). Items: its top-level bullets, stored as written. File present without
  the section: readable, no items. The rest of GEMINI.md is hand-written instructions; `hippo import --markdown`
  covers it.
- Project container (auto memory, experimental, off by default): `<gemini folder>/tmp/<slug>/memory/`, where
  `<slug>` is the entry in `<gemini folder>/projects.json` (`{ "projects": { "<absolute path>": "<slug>" } }`) for
  the project root or its git top level, compared case-insensitively on win32. Items: `*.md` directly in the folder
  except `MEMORY.md`; dot entries and `skills/` skipped. A `projects.json` that fails to parse marks the listing
  incomplete.
- Not read: v0.43's project-scope bullets (one release, path not checked); facts kept only inline in the project
  `MEMORY.md`.

**GitHub Copilot Chat in VS Code** (`copilot`, tag `copilot-memory`). The memory tool is on by default.
- VS Code data folders, as VS Code resolves them (userDataPath.ts): `$VSCODE_PORTABLE/user-data` when set; else
  `$VSCODE_APPDATA/<product>`; else `%APPDATA%/<product>` on win32, `~/Library/Application Support/<product>` on
  darwin, `${XDG_CONFIG_HOME:-~/.config}/<product>` on linux; `<product>` is `Code` and `Code - Insiders`.
- User container: `<data>/User/globalStorage/github.copilot-chat/memory-tool/memories/`.
- Project containers: `<data>/User/workspaceStorage/<id>/github.copilot-chat/memory-tool/memories/repo/` for each
  `<id>` whose `workspace.json` `folder` URI is exactly the project root or its git top level. Multi-root workspaces
  (a `workspace` key) are skipped. Only folders that hold `memory-tool/memories/repo` have their `workspace.json`
  read.
- Items: every file under the container, any depth (the model picks the paths and names).
- Not read: session memories (scratch, per chat) and `--user-data-dir` folders.

**OpenClaw** (`openclaw`, tag `openclaw-memory`).
- Workspace: `OPENCLAW_WORKSPACE_DIR` (used as written, no `~` expansion); else `<state>/workspace`, where `<state>`
  is `OPENCLAW_STATE_DIR`, else `<OPENCLAW_HOME or home>/.openclaw-<OPENCLAW_PROFILE>` for a profile other than
  `default`, else `<OPENCLAW_HOME or home>/.openclaw`.
- User container: `<workspace>/MEMORY.md`. Items: its bullets and paragraphs, stored as `<nearest heading>: <item>`.
- Not read: `agents.defaults.workspace` in `openclaw.json` (JSON5; hippo has no parser, SHORTCUT noted in the
  adapter), the daily notes `memory/YYYY-MM-DD.md`, `USER.md`, `DREAMS.md`.

**Qwen Code** (`qwen-code`, tag `qwen-code-memory`). Auto memory is on by default.
- Base: `QWEN_CODE_MEMORY_BASE_DIR`, else `QWEN_RUNTIME_DIR`, else `QWEN_HOME`, else `<home>/.qwen`.
- Project container: `<project root>/.qwen/memory/` when `QWEN_CODE_MEMORY_LOCAL=1`; else
  `<base>/projects/<key>/memory/`, where `<key>` is the project root when `QWEN_CODE_MEMORY_PROJECT_SCOPE=workspace`,
  else the nearest folder at or above it holding `.git` (a linked worktree keeps its own), else the resolved project
  root, passed through Qwen's `sanitizeCwd` (lowercased on win32, then every non-alphanumeric made `-`, no length
  cap).
- User container: `<base>/memories/`.
- Items: `*.md` at any depth except the top `MEMORY.md`, `pinned/` included, frontmatter optional.
- Not read: a runtime folder pinned in Qwen's settings, and team memory.

**Skipped, with the reason** (listed in the README):
- Windsurf: the folder is known (`~/.codeium/windsurf/memories/`), the file format is not, and Cascade reached end of
  life on 1 July 2026.
- Cursor, Copilot CLI and GitHub's Copilot Memory: the memories live on the vendor's servers.
- Kiro: the local store is not documented.
- Cline and Roo memory banks: files in the repository, which `init --scan` and `hippo import --markdown` cover.
- Amp, Aider, Continue, OpenCode, pi: no memory feature found.

## Build order
One branch, one commit per step, each step green before the next: the engine (tools.ts, markdown.ts, plan.ts,
sync.ts) with Claude Code and Codex (PR 2's promise and what Z0 needs); then Qwen and Copilot (on by default for
their users); then Gemini and OpenClaw. If the diff passes about 2,500 lines, the last two steps go in a second PR.

## Changes from compaction PR 2
- Tool-agnostic: adapters plus one sync, not a Claude-only function.
- No `claude_memory_notes` table: the key and hash live in `source`. The primary key's job (two first imports give
  one row) moves to the container's `BEGIN IMMEDIATE`.
- Key prefix `agent-memory:claude-code:` instead of `claude-memory:`, so legacy rows are not kept unless adopted.
- A deleted note's row is set aside (dormant, restorable), not only untagged.
- A user's `hippo supersede` of an imported row holds until the note changes; a deleted note that comes back gets its
  old row back; items carry their own time; containers are named by a hash of their real path.

## Loss windows
- The sync dies mid-container: the transaction rolls back; the next sync redoes the container. Mirrors are
  best-effort after commit (store.ts:1709), as for every write.
- A tool changes its store's shape: that container reads as unreadable, one warning line, nothing set aside.
- A note is edited and deleted between syncs: hippo sees only the end state.
- A busy store: the container waits for the next sync.
- The process dies after a set-aside commits but before its mirror is purged: rebuildIndex brings the row back live
  and tagged, and the next sync sets it aside again.
- A moved project whose memory folder was copied: both containers' rows stay kept and live, so a note deleted in the
  new folder is still served from the old container's row. `import --agents --dry-run` prints how many such rows
  exist; clearing them is by hand (`hippo forget`).

## Tests (named after the behaviour; seeded through initStore/createMemory/writeEntry)
- plan.ts, table-driven over every line of design 6, legacy adoption's two rounds included.
- The PR 2 list: new note imported; unchanged skipped; an edit past char 1500 supersedes; two concurrent first
  imports give one row (4 child processes x 40 notes, as store-stats-concurrency.test.ts sizes its race); a deleted
  note is set aside and restorable; a missing folder changes nothing; a note whose row is dormant from decay gets a
  live row; legacy key adopted at sleep in the store's own project only; Windows folder case normalised; a secret
  note skipped; nothing printed by the sync; notes never merged; session end in a folder without a store imports the
  transcript's notes into the global store with the project's origin.
- Added:
  - a user-superseded row left alone while the note is unchanged, then superseded when it changes;
  - a deleted note that comes back unchanged is restored from dormant with its id; a restored set-aside row is left
    alone while the note stays gone;
  - A to B to A; two tagged rows for one key collapse to the newest; a restore after a rewrite survives two syncs;
  - a tagged row set aside through the real SQL (the keep rule does not block it); a pinned row loses its tag and
    stays live; `hippo rebuild-index` after a set-aside does not bring it back;
  - an unread item (a failed read, 256 KB) leaves its row alone; a refused item (edited to hold a secret, cut under
    10 characters, rejected) sets its tagged row aside;
  - the handover: global `p-` rows from the store-less hook path are set aside when the project's own store syncs
    that container; a project Y row with the same text does not hide the note from project X in the global store;
    a worktree and its main checkout each keep a global row of their shared folder, and handover retires only its
    own origin's; a note the local pass could not read keeps its global row; a folder with no git hands over the
    rows it wrote with origin `''` before its store existed;
  - post-compact reads the transcript folder only and runs no git call;
  - a malformed dormant snapshot does not stop the sync; a superseded dormant snapshot is never restored;
  - `HIPPO_AGENT_MEMORY_TOOLS` overrides config; `[]` in a project store stops that project's user pass;
  - a rejected value counted with no write and no audit row; a forgotten row re-imported;
  - a one-line preference bullet is imported (the worth check is off);
  - `created` carries the item's time as a 24-character Z timestamp, from an offset `modified` too, and a 40-note
    import leaves the recent-N slots to newer rows;
  - a user container lands in the global store with origin ''; a global-store sleep runs the user pass only;
  - `hippo sync` never copies a `u-` row into a project store; an imported row is never auto-shared;
  - two projects' sleeps racing on the user pass; a busy container skipped with nothing set aside;
  - a git failure sets nothing aside; a moved project root leaves the old container's rows alone;
  - the 256 KB, NUL-byte and failed-read skips; duplicate bullets under one heading get `~2`;
  - `--no-learn`, `agentMemories.tools: []` and a one-tool list; `init` on an existing store imports new notes;
    `init --global` on an existing global store; `init --scan`; `setup`; `import --agents --dry-run` writes nothing.
- Every layout the current test file covers (subfolder store, linked worktree, bare repository, separate git dir,
  submodule, hashed long names, exactly 200 characters), moved from tests/claude-memory-import.test.ts.
- Per adapter: every home rule in its Adapters entry, a fixture store giving the expected items and times, and a
  broken shape (a Codex summary without `v1`, a malformed `projects.json` or `workspace.json`) read as unreadable
  with one warning.
- Real homes never read: a child process whose HOME, USERPROFILE, APPDATA, XDG_CONFIG_HOME and every tool variable
  point at a decoy tree full of canaries, while the injected homes point at a clean tree; no canary is imported. This
  fails if any adapter reads `os.homedir()` or `process.env` itself.
- Moved to the new function: tests/importer-secret-veto.test.ts, tests/sleep-keeps-both-versions.test.ts:557-558,
  tests/writers-configured-half-life.test.ts:102.

## Docs
README (what init, sleep and session end read, the tool list and the skip list), CLI help for init, sleep, setup and
`import --agents`, CONTEXT.md term "Imported agent memory", the Z0 prereg (below), MEMORY_ENVELOPE.md:100, the
api.ts:3189 and shared.ts:642 comments, ROADMAP item 7 under "Keep Claude Code's shape on import" (still open, now
easier), a changelog.d fragment (`### Changed`: init, sleep and session end import every agent's memories; imported
rows follow their note). No em dashes; house word list.

## Z0 prereg
Done in this branch (docs/evals/2026-09-29-z0-built-in-memory-prereg.md):
- the import is part of hippo; each run's environment sets `HIPPO_AGENT_MEMORY_TOOLS=claude-code,codex` (config
  cannot, since `hippo init` creates the store in the same command that imports), and each run reads only its own
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME`;
- stage 0's dry run runs `hippo import --agents --dry-run` in each run, fails when either home is unset or any other
  tool is listed, and keeps the canary check on the operator's real Claude Code and Codex memories, with one more
  canary in the operator's Copilot user memories (the shim changes HOME and USERPROFILE but not APPDATA);
- A5 drops the compaction hooks as well as session end, so A2 minus A5 measures capture and import together;
- the run ledger records the source prefix of every injected row, so the write-up reports what share of A2's injected
  memory was imported notes.

## CONTEXT.md term (added after compaction PR 1 merges, which edits CONTEXT.md too)
**Imported agent memory**:
A memory hippo copied from another coding agent's own memory: a Claude Code auto memory note, a Codex memory, and the
like. It follows its source item: kept while the item exists, superseded when the item changes, set aside as dormant
(restorable) when the item is deleted.
_Avoid_: synced memory, external memory, auto memory (Claude Code's own feature)

## Verify (drive the real CLI)
1. Build. A scratch HOME with a Claude config dir holding two projects' notes, a Codex home with a fixture
   `memory_summary.md`, a Gemini folder with an Added Memories section, a Qwen base, an OpenClaw workspace and a
   VS Code data folder; every tool variable in Adapters pointed at its scratch home.
2. `hippo import --agents --dry-run`: every tool's home and container count printed, nothing written.
3. `hippo init` in one project: its notes and the user-level memories imported, the other project's not; one line
   printed.
4. Edit a note past char 1500, delete another, add a secret one; `hippo sleep`: one replaced, one set aside (listed by
   `hippo dormant`), one skipped; `hippo recall --why` shows no hash.
5. Two `hippo sleep` runs at once on a fresh store: one row per note.
6. Session end in a folder without a store: the transcript's notes reach the global store with the project's origin.
7. Every tool variable pointed elsewhere: the real homes are never read (a canary file in each scratch "real" home).
8. Census: `node dist/cli.js import --agents --dry-run` counts per tool; the command goes in the report.

## Out of scope
- The 1500-character content cap (a prompt-size question, raised with Keith before, unchanged).
- Echo: hippo serving a tool's own notes back to that tool (true for Claude Code today). Filtering needs the context
  hook to know its host, a hook command change and Codex re-trusting it. ROADMAP follow-up; Z0's ledger measures it.
- Cloud-only memories (ChatGPT, Cursor's server-side memories): not on disk.
- Writing back to any tool.
- ROADMAP item 7 (frontmatter type and description as tags and hook).
- The files and settings each Adapters entry lists under "Not read", and the skipped tools.
- Codex's `MEMORY.md` task groups mapped to project stores by their working folder: a follow-up once the summary
  import has been used.

## Research
A research agent read each tool's public docs and source (no local memory files); a second agent checked every
claim against the source and marked it MATCH, partial or unreachable. Everything the Adapters section relies on
matched. Sources, by tool:
- Claude Code: code.claude.com/docs/en/memory, /settings, /env-vars, /sessions.
- Codex: openai/codex@4773a132, `codex-rs/utils/home-dir/src/lib.rs`, `ext/memories/src/extension.rs` and
  `prompts.rs` (only `memory_summary.md` is injected, truncated to 2,500 tokens), and the consolidation template's
  STRICT formats for `memory_summary.md` and `MEMORY.md`.
- Gemini CLI: tags v0.43.0 (`## Gemini Added Memories`, `GEMINI_CLI_HOME`) and v0.44.0 (`save_memory` removed),
  HEAD d75234c (project memory under `tmp/<slug>/memory/`, `projects.json`, auto memory off by default).
- Copilot Chat: microsoft/vscode-copilot-chat `memoryTool` (scopes and paths), `package.json` defaults; VS Code
  `src/vs/platform/environment/node/userDataPath.ts` (data folder rules); `workspace.json` holds `folder` as a
  `file:` URI (checked on a local install, keys only).
- OpenClaw: docs `concepts/agent-workspace.md`, `help/environment.md`, `gateway/config-agents/workspace-and-bootstrap.md`,
  `cli/config.md` (`openclaw.json` is JSON5).
- Qwen Code: QwenLM/qwen-code@8c914eb `packages/core/src/memory/paths.ts:71-148`, `config/storage.ts:172-201`.
- Windsurf: docs reached only through a mirror; the format of its memory files is not stated anywhere, so it is
  skipped.
Prior art: Codex (`external-agent-migration/src/memory.rs`) and OpenClaw both import `~/.claude/projects/*/memory/`.

## Review log
**r1, Opus plan-eng critic (REVISE, 15 findings; report in the episode folder, plan-review-r1.md).** Applied:
1. Released rows stayed injectable for years (365-day half-life): release is now a set-aside to dormant, restorable,
   with the same-hash return restoring it (design 6, CONTEXT.md term).
2. The orphan rule could release on a git timeout or another environment. Taken further than the fix proposed: the
   orphan rule is gone, and rows of an unlisted container are left alone (design 6). No per-store path record needed.
3. A project pass on the global store matched every workspace: the global store gets the user pass only, and Copilot
   matches the exact root or git top level (designs 2, 11; Adapters).
4. Z0: `agentMemories.tools` allowlist, `import --agents --dry-run`, the per-run homes as a stage 0 check, A5 drops
   compaction hooks, ledger source prefixes (design 11, 13; prereg).
5. Session end in a folder without a store now imports into the global store with the project's origin (PR 2's rule
   kept; designs 2, 11).
6. `hippo sync` skips `agent-memory:` sources and imported tags never auto-share (design 9).
7. The worth check is off for imports; secret veto, origin stamp and audit stay (design 4; the secret bar was
   tightened after PR review, see below).
8. `autoMemoryDirectory` read from user settings only (Adapters, Claude Code).
9. More than one live row for a key collapses to the newest (design 6).
10. Transactions never nest; a busy container is skipped (design 8).
12. Design 5 now lists every reader of `created`; the recall penalty is accepted; ISO-Z timestamps.
13. Canary test in a decoy-home child process, a sized race, and the missing tests (Tests).
14. Citations corrected; helpers take injected values; `--global` and re-init call sites fixed (Evidence, designs 1, 11).
15. Real paths for container ids; Qwen's no-git key; legacy adoption in two rounds; `~2` for repeated bullets; every
   changed row mirrored. Rejected-note audits: avoided by a `findRejectedValue` pre-check instead of a per-key record.
   Same folder in both scopes: moot once project settings are not read.
Not taken: 11 (ship Claude Code and Codex, defer Gemini and OpenClaw until someone asks). Keith asked for every tool;
cutting two needs his yes. The build order puts them last and allows a second PR instead.

**r2, Opus plan-eng critic (REVISE, 8 findings, text fixes only; plan-review-r2.md).** All applied:
1. The collapse undid a `hippo dormant restore`: collapse among tagged rows only, newest by `created` then id; an
   untagged row is superseded only when the note's hash matches no live row (design 6).
2. The set-aside could not use sleep's steps (its filter skips kept and pinned rows; its helpers open their own
   handle; a written mirror comes back through rebuildIndex): the four steps written out on the sync's handle, pinned
   rows lose the tag and stay, the sync's restore has its own audit op, `DormantReason` widened (design 6, 8).
3. Skipped items had no row: unread items leave rows alone, refused items set the tagged row aside (designs 4, 6, 12).
4. Hook-path rows froze once the project got a store: the handover sets them aside; the global duplicate check
   counts only rows visible to the new row's origin (designs 2, 6).
5. Post-compact through sleep broke PR 1's 10-second hook: post-compact reads the transcript folder only (designs 2,
   11).
6. The allowlist could not act on a store init creates, so Z0 leaked Copilot memories on Windows:
   `HIPPO_AGENT_MEMORY_TOOLS` overrides config, a pass needs both stores' consent, a Copilot canary (design 11, 13;
   prereg).
7. One malformed dormant snapshot failed every sync, and the scan ran on every container: `json_valid` guard, lookup
   only for present keys with no live row, superseded snapshots never restored (designs 6, 7).
8. Smaller points: dead "complete" flag dropped (`skipped` and `Listing.warnings` instead); origin needs no PR 1
   option; the rejection pre-check digests the capped text; auto-share filters on source; non-git store-less folders
   land user-global; moved-project and `dormant.enabled: false` lines added (designs 1, 2, 4, 6, 9; Loss windows).

**Build review, codex on the branch (2 findings, both reproduced, both applied):**
1. Handover set aside the global copy of a note the new local store could not read (over 256 KB, a failed read),
   leaving no live copy anywhere: unread keys are skipped (design 2).
2. A worktree and its main checkout share a Claude folder but not an origin, so the second store-less import saw the
   first one's row as unchanged and recall in the second could not see it; handover from one would also retire the
   other's rows: a project pass into the global store hashes the origin into the container id, and handover retires
   only its own origin's rows (designs 2, 3).
Found while verifying: `hippo import --agents` in a folder without a store ran only the user pass and hid the
folder's own notes; it now does what session end does there (design 11).

**Build review, codex on the delta (2 findings, 1 applied, 1 rejected):**
1. Applied: a folder with no git and no marker imports with origin `''` before `hippo init` and with its own name
   after, so handover missed its earlier global rows. Handover now also retires origin `''` rows of the synced
   containers; only a session whose notes folder is that container writes them (design 2).
2. Rejected: migrate global rows written before the origin joined the container id. No release has written
   `agent-memory:` rows; the old `claude-memory:` rows live in local stores and legacy adoption covers them.

**Build review, Opus reviewer on the branch (11 points: 3 applied, 2 closed otherwise, 6 rejected):**
1. Applied: the origin `''` handover gap, the same finding as codex's delta point 1.
2. Applied: an empty file read as a note-free file set every row aside while a tool rewrote it; it is now unread
   (designs 6, 12). OpenClaw's `MEMORY.md` was the exposed case.
3. Applied: the test run now clears the OpenClaw and Qwen variables and `HIPPO_AGENT_MEMORY_TOOLS`.
4. Closed by the tests written since: the 4x40 race, rebuild-index after a set-aside, the canary child process,
   the busy skip, never auto-shared.
5. Closed in the spec: the Codex adapter reads paragraphs and bullets under all three headings. Sub-bullets stay
   inside their bullet, so the "nested bullets become rows" part was wrong; the Codex text above now says what runs.
6. Rejected: check that `transcript_path` sits under `<config>/projects`. It is Claude's own word on where the
   session lives, the one route that still works when Claude's folder is not where hippo looks, and a caller who can
   forge hook input can read those files anyway.
7. Rejected: ignore relative tool variables. The tool resolves them against its own working folder, and hooks run
   in it; a wrong guess from a scheduled run lists a missing folder, which changes nothing (design 6).
8. Rejected: skip symlinked notes. The tools read through links, so the import sees what the agent sees.
9. Rejected: break `created` ties by recall count. The lookup and writes share one transaction and a present hash is
   never written twice, so two tagged rows of one key and hash with the same `created` cannot form.
10. Rejected: a read-only dry run. `BEGIN` takes the write lock at the first planned write and holds it for one
    container's rollback; with no store there is nothing to be a duplicate of, so the count is what a first run does.
11. Rejected: a deadline for the post-compact import. Replay's deadline is absolute, so the import's time comes out
    of replay's budget and replay's leftovers wait for the next compaction; the import reads one folder.

**PR review, Codex bot on #342 (2 findings, both applied):**
1. `detectSecret` let a note holding a Bearer header or a JWT through, and imported rows reach prompts: the secret
   bar is now any text the strict redactor would change (design 4).
2. Email addresses were stored raw, against AGENTS.md: the stored text masks them before the cap, and the hash stays
   on the raw note so a masked row still matches its note (design 4). A legacy row holding a raw email is replaced
   rather than adopted.
CI's Node 22 floor job also failed a test, not the product: `utimes` passes seconds as a double, so a `.123` mtime
read back as `.122`; the test now uses `.500`.
After master's #343 was merged in, the Windows job timed out #343's six-launch CLI test: the new win32 test files
tripled every file's time on four cores. The Windows job now runs its files one at a time.
