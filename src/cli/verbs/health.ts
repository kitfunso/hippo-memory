// Store health, connectors, the summary tree and curation verbs, in `hippo help` order.

import { TAIL_MAX_LINES } from '../../support-bundle.js';
import { DEFAULT_ASSEMBLE_BUDGET } from '../../api/assemble.js';
import { type VerbSpec, verb } from '../verb-row.js';

export const HEALTH_VERBS = {
  status: verb(() => import('../status.js'), 'handleStatus', {
    flags: {},
    usage: [`
  status                   Show memory health stats`],
  }),
  audit: verb(() => import('../audit.js'), 'handleAudit', {
    scoped: true,
    flags: {
      switches: ['apply', 'dry-run', 'fix', 'global', 'json'],
      values: ['older-than', 'op', 'since', 'tenant'],
      numbers: ['limit'],
    },
    usage: [`
  audit [--fix]            Check memory quality (--fix removes junk)
    audit repair [--apply] Preview repair of memories hippo wrote itself; --apply moves certain
                           defects to dormant storage. Sleep and the daily runner apply it once
                           per store after an upgrade
      --json              Report ids, reasons, protections and schema blockers as JSON
      --global             Operate on the global store without changing its schema
                           Writes a database backup first; undo with hippo dormant restore <id>,
                           which marks the memory verified so repair leaves it alone. Sleep's
                           dormant retention still applies; the backup stays until you remove it.`],
    listedLast: [`
  audit <sub>              Query the append-only audit log (A5 stub auth)
    audit list             List audit events for the active tenant
      --op <op>            Filter by op (remember | recall | promote |
                           supersede | forget | archive_raw | auth_revoke)
      --since <iso>        Lower bound on ts (ISO timestamp)
      --limit <n>          Max events (default: 100, max: 10000)
      --json               Output as JSON
      --global             Operate on the global store`],
  }),
  github: verb(() => import('../github.js'), 'handleGitHub', {
    flags: { switches: ['force'], values: ['max', 'repo', 'since'] },
    usage: [`
  github                   GitHub connector subcommands (backfill, dlq)
    backfill --repo <owner/name> [--since ISO] [--max <N>]
                           Paginated backfill of issues + comments
    dlq list               List DLQ entries for the active tenant
    dlq replay <id> [--force]
                           Re-ingest a DLQ entry (--force skips sig check)`],
  }),
  slack: verb(() => import('../slack.js'), 'handleSlack', {
    flags: { switches: ['force'], values: ['channel', 'since', 'team', 'tenant'] },
    usage: [`
  slack                    Slack connector subcommands (backfill, dlq, workspaces)
    backfill --channel <id> [--since ISO]
                           Backfill a channel's history (needs SLACK_BOT_TOKEN)
    dlq list               List DLQ entries for the active tenant
    dlq replay <id> [--force]
                           Re-ingest a DLQ entry (--force skips sig check)
    workspaces <add|list|remove>
                           Map Slack workspaces (team ids) to tenants`],
  }),
  provenance: verb(() => import('../status.js'), 'handleProvenance', {
    flags: { switches: ['json', 'strict'] },
    usage: [`
  provenance               Provenance coverage gate for kind='raw' rows
    --json                 Output as JSON
    --strict               Exit non-zero when coverage < 100%`],
  }),
  dag: verb(() => import('../dag.js'), 'handleDag', {
    flags: { switches: ['stats'] },
    usage: [`
  dag                      Show the summary tree: entity profiles, topic summaries, facts
    --stats                Count memories per DAG level instead`],
  }),
  drill: verb(() => import('../dag.js'), 'handleDrill', {
    scoped: true,
    flags: { switches: ['json'], values: ['budget', 'depth'], numbers: ['limit'] },
    usage: [`
  drill <summary-id>       Walk down a DAG level-2 summary to its children
    --limit N              Cap children list (default 50)
    --budget N             Token budget for the printed children (≈ chars/4)
    --json                 Output as JSON`],
  }),
  assemble: verb(() => import('../dag.js'), 'handleAssemble', {
    scoped: true,
    flags: { switches: ['json', 'no-summarize-older'], values: ['budget', 'fresh-tail', 'scope', 'session'] },
    usage: [`
  assemble --session <id>  Build a session's chronological context window
    --budget N             Token budget for the printed window (default ${DEFAULT_ASSEMBLE_BUDGET})
    --fresh-tail N         Recent rows always kept verbatim (default 10)
    --no-summarize-older   Disable older-row summary substitution
    --scope <s>            Restrict to exact scope (default: deny *:private:*)
    --json                 Output as JSON`],
  }),
  'correction-latency': verb(() => import('../status.js'), 'handleCorrectionLatency', {
    flags: { switches: ['json'] },
    usage: [`
  correction-latency       Wall-clock lag from receipt to supersession (p50/p95/max)
    --json                 Output as JSON`],
  }),
  outcome: verb(() => import('../curate.js'), 'handleOutcome', {
    scoped: true,
    flags: { switches: ['bad', 'good'], values: ['id'] },
    usage: [`
  outcome                  Apply feedback to last recall
    --good                 Memories were helpful
    --bad                  Memories were irrelevant
    --id <id>              Target a specific memory`],
  }),
  conflicts: verb(() => import('../curate.js'), 'handleConflicts', {
    flags: { switches: ['json'], values: ['status'] },
    usage: [`
  conflicts                List detected open memory conflicts
    --status <status>      Filter by status (default: open)
    --json                 Output as JSON`],
  }),
  resolve: verb(() => import('../curate.js'), 'handleResolve', {
    flags: { switches: ['forget', 'reject-loser'], values: ['keep', 'reason'] },
    usage: [`
  resolve <conflict_id>    Resolve a memory conflict
    --keep <memory_id>     Memory to keep (required)
    --forget               Delete the losing memory (default: halve half-life)
    --reject-loser         Tombstone the loser's value too (implies removal)
    --reason "<why>"       Reason for --reject-loser (default: conflict context)`],
  }),
  reject: verb(() => import('../curate.js'), 'handleReject', {
    flags: { switches: ['global'], values: ['reason', 'value'] },
    usage: [`
  reject <memory-id>       Tombstone a value so it refuses re-ingestion
    reject --value "<t>"   Pre-emptive form: tombstone a value not (currently) stored
    --reason "<why>"       Required. The tombstone stores no content — this
                           is its only human-readable identity.
    --global               Reject in the global store`],
  }),
  rejections: verb(() => import('../curate.js'), 'handleRejections', {
    flags: { switches: ['global', 'json'] },
    usage: [`
  rejections               List rejected-value tombstones for the active tenant
    --json                 Output as JSON
    --global               Operate on the global store`],
  }),
  unreject: verb(() => import('../curate.js'), 'handleUnreject', {
    flags: { switches: ['global'] },
    usage: [`
  unreject <digest-prefix> Delete a tombstone (the only escape hatch)
    --global               Operate on the global store`],
  }),
  dormant: verb(() => import('../curate.js'), 'handleDormant', {
    scoped: true,
    flags: { switches: ['global', 'json'], numbers: ['limit'] },
    usage: [`
  dormant [<query>]        List faded memories sleep kept instead of deleting
                           (on by default; "dormant": {"enabled": false} deletes instead)
    --limit <n>            Max rows, newest first (default: 20)
    --json                 Output as JSON
    --global               Operate on the global store
    dormant restore <id>   Bring a dormant memory back to active memory
    dormant forget <id>    Delete a dormant memory permanently`],
  }),
  projects: verb(() => import('../projects.js'), 'handleProjects', {
    flags: { switches: ['apply', 'global', 'json'] },
    usage: [`
  projects [list]          List the project names in a store, with a hint for old worktree names
    --json                 Output as JSON
    --global               Operate on the global store
    projects merge <from> <into> [--apply]
                           Fold one project name into another (dry run unless --apply;
                           writes a backup and one audit event first)
    projects repair [--apply]
                           Set aside misfiled note imports, fold old project names into
                           their ids, re-tag merged rows (dry run unless --apply;
                           writes a backup and one audit event first)`],
  }),
  quarantine: verb(() => import('../curate.js'), 'handleQuarantine', {
    scoped: true,
    flags: { switches: ['all', 'global', 'json'] },
    usage: [`
  quarantine [list]       List memories a connector flagged as an instruction attempt, pending review
    --all                  Include approved and rejected rows too (default: pending only)
    --json                 Output as JSON
    --global               Operate on the global store
    quarantine approve <id> Restore a quarantined memory to its original scope
    quarantine reject <id>  Keep a quarantined memory hidden for good`],
  }),
  'capture-error': verb(() => import('../session-hooks.js'), 'handleCaptureError', {
    flags: { values: ['format', 'runtime'] },
    usage: [`
  capture-error            Store a failed tool call as an error memory (reads the Claude Code
                           PostToolUseFailure hook payload on stdin; skips routine failures)
    --runtime copilot      The payload came from a Copilot hook: use the store of its cwd`],
  }),
  doctor: verb(() => import('../status.js'), 'handleDoctor', {
    flags: { switches: ['json'] },
    usage: [`
  doctor                   Check the install: Node, store, schema, sleep, agent hooks
    --json                 Machine-readable report (exit code 1 on any failure)`],
  }),
  'support-bundle': verb(() => import('../status.js'), 'handleSupportBundle', {
    flags: { switches: ['include-logs'], values: ['out'] },
    usage: [`
  support-bundle           Write a redacted JSON file for a support ticket: versions, doctor,
                           config without secrets, store counts, log names; never memory text
    --out <file>           Where to write it (default: hippo-support-<time>.json here)
    --include-logs         Add the last ${TAIL_MAX_LINES} lines of each hippo log, known secret shapes removed`],
  }),
  tokens: verb(() => import('../status.js'), 'handleTokens', {
    scoped: true,
    flags: { switches: ['global', 'json'], numbers: ['days'] },
    usage: [`
  tokens                   Tokens of memory text hippo handed agents, per surface
                           (hook, compact-resume, context, recall, MCP, HTTP), what
                           skipping unchanged hook blocks saved, and how much of the
                           hook and compact-resume blocks later model calls re-read,
                           counted when a session ends. Estimates (characters / 4)
    --days <n>             Window in days (default: 30)
    --json                 Output as JSON
    --global               Operate on the global store`],
  }),
  failures: verb(() => import('../status.js'), 'handleFailures', {
    scoped: true,
    flags: { switches: ['global', 'json'], numbers: ['days'] },
    usage: [`
  failures                 Failed tool calls capture-error saw, by outcome, and how
                           many errors first happened in another session
    --days <n>             Window in days (default: 30)
    --json                 Output as JSON
    --global               Operate on the global store`],
  }),
} satisfies Record<string, VerbSpec>;
