// First-class object, server, goal and auth verbs, in `hippo help` order.

import { DEFAULT_KEY_TTL_DAYS, MAX_TTL_DAYS } from '../../api/auth.js';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '../../server/defaults.js';
import { type VerbSpec, verb } from '../verb-row.js';

export const OBJECT_VERBS = {
  predict: verb(() => import('../predictions.js'), 'handlePredict', {
    flags: {
      values: ['actual', 'class', 'estimate', 'note', 'state', 'status', 'target', 'unit'],
      numbers: ['limit'],
    },
    usage: [`
  predict "<claim>"        Record a prediction to score against the actual outcome later
    --class <c>            Reference class (required)
    --estimate <v>         Numeric estimate
    --unit <u>             Unit of the estimate
    --target <YYYY-MM-DD>  When the outcome is due
  predict close <id>       Close a prediction
    --state <s>            closed | closed-unknown (required)
    --actual <v>           The actual value
    --note "<text>"        Closure note
  predict list [--class <c>] [--status open|closed|closed-unknown|all] [--limit N]
                           List predictions (closed and closed-unknown need --class)
  predict show <id>        Show one prediction
  predict baserate --class <c>
                           How past estimates in a class compared with the actuals`],
  }),
  decide: verb(() => import('../decisions.js'), 'handleDecide', {
    flags: { values: ['context', 'status', 'supersedes'], numbers: ['limit'] },
    usage: [`
  decide "<decision>"      Record a decision (first-class object + memory mirror)
    --context "<why>"      Why this decision was made
    --supersedes <mem-id>  Supersede the decision backed by this memory id
  decide list [--status active|superseded|closed|all] [--limit N]
                           List decisions (table is authoritative, survives decay)
  decide get <id>          Show a decision by its table id
  decide close <id>        Retire (close) an active decision by its table id`],
  }),
  incident: verb(() => import('../incidents.js'), 'handleIncident', {
    flags: { values: ['context', 'resolution', 'status'], numbers: ['limit'], lists: ['link'] },
    usage: [`
  incident "<incident>"    Record an incident (first-class object + memory mirror)
    --context "<details>"  What happened / surrounding detail
    --link <mem-id>        Link a memory as evidence (repeatable)
  incident list [--status open|resolved|closed|all] [--limit N]
                           List incidents (table is authoritative, survives decay)
  incident get <id>        Show an incident by its table id
  incident resolve <id>    Resolve an open incident (open -> resolved)
    --resolution "<text>"  How it was resolved (required)
  incident close <id>      Retire (close) an open or resolved incident by its table id`],
  }),
  process: verb(() => import('../playbooks.js'), 'handleProcess', {
    flags: { values: ['change', 'description', 'status'], numbers: ['limit'], lists: ['step'] },
    usage: [`
  process new "<name>"     Record a process map (first-class object + memory mirror)
    --step "<text>"        An ordered step (repeatable)
    --description "<text>" Optional summary of the process
  process list [--status active|superseded|closed|all] [--limit N]
                           List processes (table is authoritative, survives decay)
  process get <id>         Show a process (with its steps) by its table id
  process supersede <id>   Record a new version that supersedes an active process
    --step "<text>"        A step of the new version (repeatable, required)
    --change "<summary>"   What changed in this version (the delta note)
    --description "<text>" Optional summary of the new version
  process close <id>       Retire (close) an active process by its table id`],
  }),
  policy: verb(() => import('../playbooks.js'), 'handlePolicy', {
    flags: { values: ['change', 'from', 'name', 'status', 'text', 'to'], numbers: ['limit'] },
    usage: [`
  policy new "<name>"      Record a policy (bi-temporal first-class object + mirror)
    --text "<rule>"        The policy rule/statement (required)
    --from "<iso>"         Effective-from date (default: now)
    --to "<iso>"           Effective-to date (optional; open-ended if omitted)
  policy list [--status active|superseded|closed|all] [--limit N]
                           List policies (table is authoritative, survives decay)
  policy get <id>          Show a policy by its table id
  policy asof "<iso-date>" Show active policies in force at a valid-time
    --name "<policy>"      Filter to one policy by name
  policy supersede <id>    Record a new version that supersedes an active policy
    --text "<rule>"        The new rule (required)
    --from "<iso>"         New effective-from (default: now)
    --to "<iso>"           New effective-to (optional)
    --change "<summary>"   What changed in this version (the delta note)
  policy close <id>        Retire (close) an active policy by its table id`],
  }),
  skill: verb(() => import('../playbooks.js'), 'handleSkill', {
    flags: { values: ['change', 'instructions', 'status', 'trigger'], numbers: ['limit'] },
    usage: [`
  skill new "<name>"       Record a skill (reusable agent-followable capability)
    --instructions "<txt>" The skill body (required)
    --trigger "<when>"     Optional: when to apply this skill
  skill list [--status active|superseded|closed|all] [--limit N]
                           List skills (table is authoritative, survives decay)
  skill get <id>           Show a skill by its table id
  skill export             Render active skills as an AGENTS.md/CLAUDE.md markdown block
  skill supersede <id>     Record a new version that supersedes an active skill
    --instructions "<txt>" The new skill body (required)
    --trigger "<when>"     Optional new trigger
    --change "<summary>"   What changed in this version (the delta note)
  skill close <id>         Retire (close) an active skill by its table id`],
  }),
  brief: verb(() => import('../briefs.js'), 'handleProjectBrief', {
    aliases: ['project-brief'],
    dryRun: { form: 'refresh', honoured: (args) => args[0] === 'refresh' },
    flags: { switches: ['dry-run'], values: ['change', 'repo', 'status', 'summary'], numbers: ['limit'] },
    usage: [`
  brief new "<repo>"       Record a repo-scoped project brief
    --summary "<text>"     The brief body (required)
  brief list [--status active|superseded|closed|all] [--repo "<repo>"] [--limit N]
                           List project briefs (table is authoritative, survives decay)
  brief get <id>           Show a project brief by its table id
  brief supersede <id>     Record a new version that supersedes an active brief
    --summary "<text>"     The new brief body (required)
    --change "<summary>"   What changed in this version (the delta note)
  brief close <id>         Retire (close) an active project brief by its table id
  brief refresh "<repo>"   Auto-assemble the brief from the repo's receipts (path:<repo>)
    --dry-run              Print the assembled brief without writing it`],
  }),
  note: verb(() => import('../notes.js'), 'handleCustomerNote', {
    aliases: ['customer-note'],
    flags: { values: ['change', 'customer', 'status', 'text'], numbers: ['limit'] },
    usage: [`
  note new "<customer>"    Record a customer/account-scoped note
    --text "<note>"        The note body (required)
  note list [--status active|superseded|closed|all] [--customer "<id>"] [--limit N]
                           List customer notes (table is authoritative, survives decay)
  note get <id>            Show a customer note by its table id
  note supersede <id>      Record a new version that supersedes an active note
    --text "<note>"        The new note body (required)
    --change "<summary>"   What changed in this version (the delta note)
  note close <id>          Retire (close) an active customer note by its table id`],
  }),
  graph: verb(() => import('../graph.js'), 'handleGraph', {
    flags: { switches: ['json', 'open'], values: ['entity', 'format', 'out'] },
    usage: [`
  graph extract            Rebuild the entity/relation graph from consolidated objects
                           (decisions/policies/customer-notes/project-briefs); idempotent`],
  }),
  invalidate: verb(() => import('../curate.js'), 'handleInvalidate', {
    flags: { switches: ['churn', 'dry-run'], values: ['id', 'reason'] },
    usage: [`
  invalidate "<pattern>"   Actively weaken memories matching an old pattern
                           (content overlap, or a tag EXACTLY equal to the
                           full pattern - never token-level tag matching)
    --id <memory-id>       Invalidate exactly one memory (instead of a pattern)
    --dry-run              Preview what would be hit; writes nothing
                           Note: a pattern equal to the system tag
                           'invalidated' re-weakens previously invalidated
                           memories - preview with --dry-run first
    --reason "<why>"       Optional: what replaced it
  invalidate --churn       FE2: tag memories 'churn-stale' whose named file
                           changed or was deleted, or whose named symbol or
                           npm script was removed, in this repo's git history
                           since the memory was stored or confirmed
    --dry-run              Preview what would be tagged; writes nothing`],
  }),
  wm: verb(() => import('../continuity.js'), 'handleWm', {
    flags: { switches: ['json'], values: ['content', 'importance', 'scope', 'session', 'task'], numbers: ['limit'] },
    usage: [`
  wm <sub>                 Working memory — bounded buffer for current state
    wm push                Push a working memory entry
      --scope <scope>      Scope name (default: default)
      --content <text>     Content to store (required)
      --importance <n>     Priority 0-1 (default: 0.5)
      --session <id>       Session ID
      --task <id>          Task ID
    wm read                Read working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
      --limit <n>          Max entries (default: 20)
      --json               Output as JSON
    wm clear               Clear working memory entries
      --scope <scope>      Filter by scope
      --session <id>       Filter by session
    wm flush               Same as clear; nothing runs it at session end
      --scope <scope>      Filter by scope
      --session <id>       Filter by session`],
  }),
  dashboard: verb(() => import('../serve.js'), 'handleDashboard', {
    flags: { numbers: ['port'] },
    usage: [`
  dashboard                Open web dashboard for memory health
    --port <n>             Port to serve on (default: 3333)`],
  }),
  mcp: verb(() => import('../serve.js'), 'handleMcp', {
    flags: {},
    usage: [`
  mcp                      Start MCP server (stdio transport)`],
  }),
  serve: verb(() => import('../serve.js'), 'handleServe', {
    flags: { values: ['host', 'tls-cert', 'tls-key'], numbers: ['port'] },
    usage: [`
  serve                    Start the HTTP API server for this store (Ctrl+C stops it)
    --port <n>             Port to serve on (default: $HIPPO_PORT or ${DEFAULT_SERVER_PORT})
    --host <host>          Address to bind (default: ${DEFAULT_SERVER_HOST})
    --tls-cert <file>      PEM certificate; serve HTTPS only (or $HIPPO_TLS_CERT)
    --tls-key <file>       PEM private key for it; give both (or $HIPPO_TLS_KEY)
                           Every request needs an API key (hippo auth create).
                           $HIPPO_ALLOW_KEYLESS_LOCAL=1 lets requests from this machine
                           in without one; $HIPPO_REQUIRE_AUTH=1 wins over it.`],
  }),
  goal: verb(() => import('../goals.js'), 'handleGoal', {
    scoped: true,
    flags: {
      switches: ['all', 'no-propagate'],
      values: ['level', 'outcome', 'parent', 'policy', 'session-id', 'success', 'tenant-id'],
    },
    usage: [`
  goal <sub>               dlPFC goal stack (B3) — scoped per session
    goal push <name>       Push a new active goal; prints the new goal id
      --policy <type>      schema-fit-biased | error-prioritized |
                           recency-first | hybrid
      --success "<cond>"   Optional success condition text
      --level <n>          Goal level (default: 0)
      --parent <goalId>    Parent goal id (for sub-goals)
      --session-id <s>     Override session (defaults to HIPPO_SESSION_ID)
      --tenant-id <t>      Override tenant (defaults to HIPPO_TENANT)
    goal list              Show active goals as a table
      --all                Include suspended/completed goals
    goal complete <id>     Mark a goal completed
      --outcome <0..1>     Outcome score; >=0.7 boosts, <0.3 decays recalled mems
      --no-propagate       Close the goal without applying strength side-effects
    goal suspend <id>      Move an active goal to suspended
    goal resume <id>       Move a suspended goal back to active (depth-capped)`],
  }),
  auth: verb(() => import('../auth.js'), 'handleAuth', {
    scoped: true,
    flags: { switches: ['all', 'global', 'json', 'no-expiry'], values: ['label', 'role', 'tenant'], numbers: ['ttl-days'] },
    usage: [`
  auth <sub>               Manage API keys (A5 stub auth)
    auth create            Mint a new API key (plaintext shown ONCE)
      --label <s>          Optional human label
      --role <r>           admin | member (default: member; member blocked from /v1/sleep)
      --ttl-days <n>       Days until the key expires (default: ${DEFAULT_KEY_TTL_DAYS}, at most ${MAX_TTL_DAYS})
      --no-expiry          Mint a key that never expires
      --tenant <id>        Override tenant (defaults to HIPPO_TENANT)
      --json               Output as JSON
      --global             Operate on the global store
    auth list              List API keys (active by default)
      --all                Include revoked and expired keys
      --json               Output as JSON
      --global             Operate on the global store
    auth revoke <key_id>   Revoke an API key (subsequent validate fails)
      --json               Output as JSON
      --global             Operate on the global store
    auth grant <key_id> <scope>    Let a member key read one restricted scope
      --json               Output as JSON
      --global             Operate on the global store
    auth ungrant <key_id> <scope>  Remove a scope grant
      --json               Output as JSON
      --global             Operate on the global store`],
  }),
} satisfies Record<string, VerbSpec>;
