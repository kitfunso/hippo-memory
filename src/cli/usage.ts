// The help listing's header and examples, and the longer usage of a few sub-commands; each verb's help is in its row.

export function printAuditPruneUsage(): void {
  console.log('hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>]');
  console.log('  --older-than <Nd>  Delete audit_log rows with ts older than N days (e.g. 90d).');
  console.log('  --dry-run          Count matching rows without deleting (operator safety).');
  console.log('  --tenant <t>       Tenant scope. Defaults to HIPPO_TENANT or "default".');
  console.log('  --json             Output the result as JSON {cutoff, count, dryRun}.');
}

export function printSlackBackfillUsage(): void {
  console.log('hippo slack backfill --channel <id> [--since ISO]');
  console.log('  --channel  Slack channel id (required, e.g. C0123ABC)');
  console.log('  --since    backfill from ISO timestamp (default: cursor)');
}

export function printSlackWorkspacesUsage(): void {
  console.log('hippo slack workspaces <add|list|remove> [options]');
  console.log('  add --team <T> --tenant <t>   Register a workspace (upserts on existing team-id)');
  console.log('  list                          List all registered workspaces');
  console.log('  remove --team <T>             Remove a workspace registration');
}

export const USAGE_HEADER = `
Hippo - Make your agent's memory work like a brain. Hippo is long-term memory for coding agents.

Usage: hippo <command> [options]

Commands:`;

export const USAGE_EXAMPLES = `

Examples:
  hippo init
  hippo remember "FRED cache can silently drop series" --tag error
  hippo recall "data pipeline issues" --budget 2000
  hippo context --auto --budget 1500
  hippo conflicts
  hippo reject mem_abc123 --reason "leaked credential"
  hippo reject --value "never store my key again" --reason "secret"
  hippo rejections
  hippo unreject a1b2c3d4e5f6
  hippo dormant "staging hostname"
  hippo dormant restore mem_abc123
  hippo tokens --days 7
  hippo session log --id sess_123 --task "Ship feature" --type progress --content "Build is green, next step is docs"
  hippo session latest --json
  hippo session resume
  hippo snapshot save --task "Ship feature" --summary "Tests are green" --next-step "Open the PR" --session sess_123
  hippo handoff create --summary "PR is open, tests green" --next "Merge after review" --session sess_123 --artifact src/foo.ts
  hippo handoff create --summary s --constraint a --constraint b --outcome partial --target-runtime codex --card-id c1 --tests pass
  hippo card create --title "Add cards table" --repo hippo --depends-on card_abc
  hippo card claim card_abc --runtime codex
  hippo card complete card_abc --outcome success
  hippo card heartbeat card_abc --run 7
  hippo card reclaim
  hippo embed --status
  hippo watch "npm run build"
  hippo learn --git --days 30
  hippo promote mem_abc123
  hippo sync
  hippo setup
  hippo hook install claude-code
  hippo decide "Use PostgreSQL for new services" --context "JSONB support"
  hippo incident "Prod outage: DB connection pool exhausted" --context "spike at 14:00"
  hippo process new "Release" --step "run tests" --step "bump version" --step "publish"
  hippo policy new "Data retention" --text "Delete logs after 90 days" --from 2026-01-01
  hippo policy asof 2026-03-01 --name "Data retention"
  hippo skill new "Run tests" --instructions "npm test before every commit" --trigger "before commit"
  hippo skill export
  hippo brief new "hippo" --summary "Agent-memory library; E2 first-class objects in progress"
  hippo brief refresh "hippo"
  hippo note new "Acme Corp" --text "Renewal call: wants SSO before Q3; champion is the VP Eng"
  hippo note list --customer "Acme Corp" --status active
  hippo graph extract
  hippo invalidate "REST API" --dry-run
  hippo invalidate "REST API" --reason "migrated to GraphQL"
  hippo invalidate --id mem_a1b2c3d4e5f6 --reason "superseded by new policy"
  hippo invalidate --churn --dry-run
  hippo export memories.json
  hippo export --format markdown memories.md
  hippo sleep --dry-run
  hippo outcome --good
  hippo status
`;
