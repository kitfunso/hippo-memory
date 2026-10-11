// Continuity, transfer, capture and agent-hook verbs, in `hippo help` order.

import { boolFlag } from '../flag-values.js';
import { type VerbSpec, verb } from '../verb-row.js';

export const SESSION_VERBS = {
  snapshot: verb(() => import('../continuity.js'), 'handleSnapshot', {
    flags: { switches: ['json'], values: ['id', 'next-step', 'session', 'source', 'status', 'summary', 'task'] },
    usage: [`
  snapshot <sub>           Persist or inspect the current active task
    snapshot save          Save active task state
      --task <task>
      --summary <summary>
      --next-step <step>
      --source <source>    Optional source label
      --session <id>       Link snapshot to a session trail
    snapshot show          Show the active task snapshot
      --json               Output as JSON
    snapshot clear         Clear the active task snapshot
      --status <status>    Mark final status (default: cleared)`],
  }),
  session: verb(() => import('../continuity.js'), 'handleSession', {
    flags: {
      switches: ['json'],
      values: ['content', 'id', 'outcome', 'session', 'source', 'summary', 'task', 'type'],
      numbers: ['limit'],
    },
    usage: [`
  session <sub>            Append or inspect short-term session history
    session log            Append a structured session event
      --id <session-id>
      --content <text>
      --type <type>        Event type (default: note)
      --task <task>        Optional task label
      --source <source>    Optional source label
    session show           Show recent events for a session or task
      --id <session-id>
      --task <task>
      --limit <n>          Event limit (default: 8)
      --json               Output as JSON
    session latest         Show latest task snapshot + events
      --id <session-id>   Filter by session
      --json               Output as JSON
    session resume         Re-inject latest handoff as context output
      --id <session-id>   Filter by session`],
  }),
  handoff: verb(() => import('../continuity.js'), 'handleHandoff', {
    flags: {
      switches: ['json'],
      values: ['card-id', 'id', 'next', 'outcome', 'session', 'summary', 'target-runtime', 'task', 'tests'],
      lists: ['artifact', 'constraint'],
    },
    usage: [`
  handoff <sub>            Manage session handoffs for continuity
    handoff create         Create a new session handoff
      --summary <text>     Handoff summary (required)
      --next <text>        Next action for successor
      --session <id>       Session ID (auto-generated if omitted)
      --task <id>          Associated task ID
      --artifact <path>    Related file path (repeatable)
      --constraint <text>  Constraint for the successor to respect (repeatable)
      --outcome <o>        success | failure | partial
      --target-runtime <n> Name of the runtime the successor will run in
      --card-id <id>       Associated card/ticket ID
      --tests <status>     pass | fail | unknown (default: unknown)
    handoff latest         Show the most recent handoff
      --session <id>       Filter by session
      --json               Output as JSON
    handoff show <id>      Show a specific handoff by ID`],
  }),
  card: verb(() => import('../card.js'), 'handleCard', {
    // Every card subcommand's flags together; card.ts then refuses the ones its subcommand does not read.
    flags: {
      switches: ['json'],
      values: ['author', 'body', 'budget', 'contract', 'outcome', 'reason', 'repo', 'run', 'runtime', 'session',
        'status', 'title'],
      lists: ['depends-on'],
    },
    usage: [`
  card <sub>                Manage claimable work-queue cards
    card create             Create a new card
      --title <text>        Card title (required)
      --repo <name>         Associated repo
      --contract <text>     Associated contract
      --budget <n>           Token/step budget
      --depends-on <id>     Parent card id (repeatable)
    card show <id>          Show a card, its deps, runs, comments and latest handoff
      --json                 Output as JSON
    card list                List cards, newest-updated first
      --status <status>     Filter by status
    card claim <id>          Claim a ready or blocked card; prints its run id and lease
      --runtime <name>       Claiming runtime (required)
      --session <id>         Session ID
    card heartbeat <id>       Extend a running card's lease
      --run <n>              Your run id, as card claim printed it (required)
    card block <id>           Block a running card
      --reason "<why>"       Reason recorded as a card comment (required)
      --run <n>              Refuse unless <n> is the card's live run
    card review <id>          Move a running card to review
      --run <n>              Refuse unless <n> is the card's live run
    card complete <id>       Complete a card in review
      --outcome <o>          success | failure | partial (required)
      --run <n>              Refuse unless <n> is the card's live run
    card reclaim              Return every running card whose lease has expired to ready
    card comment <id>         Add a comment to a card
      --body <text>          Comment body (required)
      --author <name>       Comment author (default: cli)`],
  }),
  current: verb(() => import('../continuity.js'), 'handleCurrent', {
    flags: { switches: ['json'] },
    usage: [`
  current <sub>            Show compact current state for agent injection
    current show           Active task + recent session events (default)
      --json               Output as JSON`],
  }),
  forget: verb(() => import('../curate.js'), 'handleForget', {
    scoped: true,
    flags: { switches: ['archive', 'dry-run'], values: ['reason'] },
    usage: [`
  forget <id>              Force remove a memory
    --archive              Archive a raw (append-only) memory instead of deleting
    --reason "<why>"       Reason recorded on the archive (required with --archive)`],
  }),
  inspect: verb(() => import('../status.js'), 'handleInspect', {
    flags: {},
    usage: [`
  inspect <id>             Show full memory detail`],
  }),
  embed: verb(() => import('../maintenance.js'), 'handleEmbed', {
    flags: { switches: ['global', 'reset-physics', 'status'] },
    usage: [`
  embed                    Embed all memories for semantic search
    --status               Show embedding coverage`],
  }),
  watch: verb(() => import('../transfer.js'), 'handleWatch', {
    flags: {},
    usage: [`
  watch "<command>"        Run command, auto-learn from failures`],
  }),
  learn: verb(() => import('../transfer.js'), 'handleLearn', {
    scoped: true,
    flags: { switches: ['git'], values: ['repos'], numbers: ['days'] },
    usage: [`
  learn                    Learn lessons from repository history
    --git                  Scan recent git commits for lessons
    --days <n>             Scan this many days back (default: 7)
    --repos <paths>        Comma-separated repo paths to scan`],
  }),
  promote: verb(() => import('../transfer.js'), 'handlePromote', {
    scoped: true,
    flags: {},
    usage: [`
  promote <id>             Copy a local memory to the global store`],
  }),
  share: verb(() => import('../transfer.js'), 'handleShare', {
    dryRun: { form: '--auto', honoured: (args, flags) => args[0] === '--auto' || boolFlag(flags, 'auto') },
    flags: { switches: ['auto', 'dry-run', 'force'], numbers: ['min-score'] },
    usage: [`
  share <id>               Share a memory with attribution + transfer scoring
    --force                Share even if transfer score is low
    --auto                 Auto-share all high-transfer-score memories
    --dry-run              Preview what would be shared
    --min-score <n>        Minimum transfer score (default: 0.6)`],
  }),
  peers: verb(() => import('../transfer.js'), 'handlePeers', {
    flags: { switches: ['all-tenants'] },
    usage: [`
  peers                    List projects contributing to global store`],
  }),
  sync: verb(() => import('../transfer.js'), 'handleSync', {
    flags: { switches: ['cross-project'] },
    usage: [`
  sync                     Pull global memories into local project`],
  }),
  import: verb(() => import('../transfer.js'), 'handleImport', {
    flags: {
      switches: ['agents', 'dry-run', 'global'],
      values: ['chatgpt', 'claude', 'cursor', 'file', 'markdown', 'name', 'scope', 'vault'],
      lists: ['tag'],
    },
    usage: [`
  import                   Import memories from other AI tools
    --chatgpt <path>       Import from ChatGPT memory export (JSON or txt)
    --claude <path>        Import from CLAUDE.md or Claude memory.json
    --cursor <path>        Import from .cursorrules or .cursor/rules
    --file <path>          Import from any markdown or text file
    --markdown <path>      Import from structured MEMORY.md / AGENTS.md
    --vault <path>         Import a markdown-vault FOLDER as kind='raw' notes
                             (Obsidian/Foam/Dendron). Requires --name <vault>.
                             [--scope <scope>]
    --agents               Sync every coding agent's own memories (Claude Code, Codex,
                             Gemini CLI, Copilot, OpenClaw, Qwen Code) now; with
                             --dry-run, print each tool's folders and what would change.
                             HIPPO_AGENT_MEMORY_TOOLS=<ids> or config agentMemories.tools
                             picks the tools; "none" or [] turns the import off
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)
    --tag <tag>            Add extra tag (repeatable)`],
  }),
  export: verb(() => import('../transfer.js'), 'handleExport', {
    flags: { values: ['format'] },
    usage: [`
  export [file]            Export all memories (default: stdout)
    --format <fmt>         Output format: json (default) or markdown`],
  }),
  capture: verb(() => import('../session-hooks.js'), 'handleCapture', {
    flags: { switches: ['dry-run', 'global', 'last-session', 'stdin'], values: ['file', 'log-file', 'transcript'] },
    usage: [`
  capture                  Extract memories from conversation text
    --stdin                Read from piped input
    --file <path>          Read from a file
    --last-session         Read the transcript a hook names on stdin, else the newest
                           Claude Code one from any project
    --transcript <path>    Explicit transcript path (implies --last-session)
    --log-file <path>      Tee output to a log file (paired with 'hippo last-sleep')
    --dry-run              Preview without writing
    --global               Write to global store ($HIPPO_HOME or ~/.hippo/)`],
  }),
  setup: verb(() => import('../setup.js'), 'handleSetup', {
    flags: { switches: ['all', 'dry-run', 'no-learn', 'no-schedule'] },
    usage: [`
  setup                    One-shot: detect installed AI tools and install their hooks:
                           claude-code gets 7 hooks in $CLAUDE_CONFIG_DIR/settings.json
                           (~/.claude by default), opencode a plugin, codex 2 hooks in
                           its hooks.json plus a launcher wrapper, copilot 4 hooks, the
                           MCP server and an instructions block under $COPILOT_HOME
                           (~/.copilot by default); other tools get a
                           hint. Then imports each agent's
                           user-level memories into the global store
    --all                  Install for every JSON-hook tool, even if not detected
    --dry-run              Show what would be installed without writing
    --no-schedule          Skip installing or repairing the daily runner
    --no-learn             Skip the agent memory import`],
  }),
  'last-sleep': verb(() => import('../last-sleep.js'), 'handleLastSleep', {
    flags: { switches: ['keep'], values: ['path'] },
    usage: [`
  last-sleep               Show the last sleep log on stderr, one problems line to the user, and clear it
    --path <p>             Log path (default: ~/.hippo/logs/last-sleep.log)
    --keep                 Print without clearing`],
  }),
  'session-end': verb(() => import('../session-hooks.js'), 'handleSessionEnd', {
    // Its sleep step reads --dry-run, but the capture after it writes for real.
    dryRun: false,
    flags: {
      switches: ['dry-run', 'no-learn', 'no-share', 'turn'],
      values: ['format', 'log-file', 'runtime', 'session-id', 'transcript'],
    },
    usage: [`
  session-end              SessionEnd hook: count this session's re-read tokens, run sleep, then
                           capture from the session's last 20 user and 10 assistant messages,
                           in a detached worker
    --log-file <path>      Tee the worker's output to a log file (paired with 'hippo last-sleep')
    --runtime copilot      The payload came from a Copilot hook: use the store of its cwd and find
                           the Copilot CLI session log by session id; with no --log-file, log to
                           ~/.hippo/logs/copilot-sleep.log
    --turn                 VS Code Stop hook, after each reply: capture only the new turns, sleep
                           only at the auto-sleep threshold, and keep the session's snapshot; does
                           nothing for any other payload`],
  }),
  '__session-end-worker': verb(() => import('../session-hooks.js'), 'handleSessionEndWorker', {
    dryRun: false,
    flags: {
      switches: ['dry-run', 'no-learn', 'no-share', 'turn'],
      values: ['log-file', 'session-id', 'transcript'],
    },
  }),
  'pre-compact': verb(() => import('../session-hooks.js'), 'handlePreCompact', {
    flags: { values: ['format', 'log-file', 'runtime'] },
    usage: [`
  pre-compact              PreCompact hook: record the compaction, save a working-state snapshot, and
                           ask the summariser to end with a "Memories for hippo" list
    --log-file <p>         Diagnostic log path (default: ~/.hippo/logs/pre-compact.log)
    --runtime copilot      The payload came from a Copilot hook: use the store of its cwd and save
                           the snapshot only (Copilot has no PostCompact hook to close a record)`],
  }),
  'compact-resume': verb(() => import('../session-hooks.js'), 'handleCompactResume', {
    flags: {},
    usage: [`
  compact-resume           SessionStart(compact) hook: re-print the snapshot, if under 15 minutes old`],
  }),
  'post-compact': verb(() => import('../session-hooks.js'), 'handlePostCompact', {
    flags: { values: ['log-file'] },
    usage: [`
  post-compact             PostCompact hook: keep that list as memories (a busy store leaves the save to
                           the next hippo sleep) and print one line saying how many
    --log-file <p>         Same log path as pre-compact (default: ~/.hippo/logs/pre-compact.log)`],
  }),
  'codex-run': verb(() => import('../session-hooks.js'), 'handleCodexRun', {
    flags: {},
    usage: [`
  codex-run [-- ...args]   Launch real Codex behind Hippo's session-end wrapper`],
  }),
  '__codex-session-end-worker': verb(() => import('../session-hooks.js'), 'handleCodexSessionEndWorker', {
    flags: { values: ['codex-home', 'history-path', 'log-file', 'start-offset', 'started-at'] },
  }),
  hook: verb(() => import('../setup.js'), 'handleHook', {
    flags: {},
    usage: [`
  hook <sub> [target]      Manage framework integrations
    hook list              Show available hooks
    hook install <target>  Install hook (claude-code|codex|copilot|cursor|openclaw|opencode|pi)
                           claude-code adds 7 hooks to $CLAUDE_CONFIG_DIR/settings.json
                           (~/.claude by default); opencode installs a plugin; codex
                           adds 2 hooks to $CODEX_HOME/hooks.json (trust them once in /hooks) and
                           wraps the detected launcher in place; copilot writes
                           hooks/hippo.json, the "hippo" MCP server and an instructions
                           block under $COPILOT_HOME (~/.copilot by default); all but
                           claude-code and copilot also patch an existing AGENTS.md
    hook uninstall <target> Remove hook; for copilot, only what hippo wrote`],
  }),
} satisfies Record<string, VerbSpec>;
