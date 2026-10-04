// `hippo slack`: backfill, dead-letter queue and workspace registry for the Slack connector.

import { envSlackBotToken, envSlackSigningSecret, envSlackTeamId } from '../env.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { listDlq, replayDlqEntry } from '../connectors/slack/dlq.js';
import { backfillChannel } from '../connectors/slack/backfill.js';
import { slackHistoryFetcher } from '../connectors/slack/web-client.js';
import {
  addWorkspace as addSlackWorkspace,
  listWorkspaces as listSlackWorkspaces,
  removeWorkspace as removeSlackWorkspace,
} from '../connectors/slack/workspaces.js';
import { printError } from './output.js';
import { printSlackBackfillUsage, printSlackWorkspacesUsage } from './usage.js';

// ---------------------------------------------------------------------------
// Slack subcommands (E1.3 — `hippo slack backfill` / `hippo slack dlq list`)
// ---------------------------------------------------------------------------

function cmdSlackBackfill(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const channel = typeof flags['channel'] === 'string' ? (flags['channel'] as string) : undefined;
  if (!channel) {
    printSlackBackfillUsage();
    process.exit(1);
  }
  // Real fetcher requires SLACK_BOT_TOKEN with channels:history scope.
  const token = envSlackBotToken();
  if (!token) {
    printError('SLACK_BOT_TOKEN is not set. Backfill requires a Slack bot token with channels:history scope.');
    process.exit(2);
  }
  // --since is advisory in V1: the slack_cursors row drives resume, so the
  // backfill loop always picks up where it last left off. Honoured-by-cursor
  // semantics keep idempotency clean.
  const sinceIso = flags['since'] as string | undefined;
  void sinceIso;
  const fetcher = slackHistoryFetcher(token);
  const ctx = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli:slack-backfill'),
  };
  backfillChannel(ctx, {
    teamId: envSlackTeamId() ?? 'T_UNKNOWN',
    channel: { id: channel, is_private: false },
    fetcher,
  })
    .then((r) => {
      console.log(`backfill ${channel}: ${r.ingested} new messages across ${r.pages} pages`);
    })
    .catch((e: Error) => {
      printError('backfill failed:', e.message);
      process.exit(3);
    });
}

function cmdSlackDlqList(hippoRoot: string, _flags: Record<string, string | boolean | string[]>): void {
  const db = openHippoDb(hippoRoot);
  try {
    const tenantId = resolveTenantId({});
    const items = listDlq(db, { tenantId });
    for (const it of items) {
      console.log(`${it.id}\t${it.receivedAt}\t${it.error}`);
    }
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackDlqReplay(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  const idArg = args[2];
  if (!idArg) {
    printError('Usage: hippo slack dlq replay <id> [--force]');
    process.exit(1);
  }
  const id = Number(idArg);
  if (!Number.isFinite(id) || !Number.isInteger(id) || id < 1) {
    printError(`replay: invalid id ${idArg}`);
    process.exit(1);
  }
  const force = flags.force === true;
  const result = replayDlqEntry(
    { hippoRoot },
    id,
    {
      force,
      signingSecret: envSlackSigningSecret(),
    },
  );
  if (!result.ok) {
    printError(
      `replay failed: status=${result.status} retry_count=${result.retryCount}${result.reason ? ` reason=${result.reason}` : ''}`,
    );
    process.exit(1);
  }
  console.log(
    `replay ok: status=${result.status} memory_id=${result.memoryId ?? '(none)'} retry_count=${result.retryCount}`,
  );
}

function cmdSlackWorkspacesAdd(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  const teamId = typeof flags['team'] === 'string' ? (flags['team'] as string).trim() : '';
  const tenantId = typeof flags['tenant'] === 'string' ? (flags['tenant'] as string).trim() : '';
  if (!teamId || !tenantId) {
    printError('Usage: hippo slack workspaces add --team <T> --tenant <t>');
    process.exit(1);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const ws = addSlackWorkspace(db, { teamId, tenantId });
    console.log(`added: ${ws.teamId} -> ${ws.tenantId} (${ws.addedAt})`);
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackWorkspacesList(hippoRoot: string): void {
  const db = openHippoDb(hippoRoot);
  try {
    const items = listSlackWorkspaces(db);
    if (items.length === 0) {
      console.log('(no registered workspaces; routing via HIPPO_TENANT fallback)');
      return;
    }
    for (const ws of items) {
      console.log(`${ws.teamId}\t${ws.tenantId}\t${ws.addedAt}`);
    }
  } finally {
    closeHippoDb(db);
  }
}

function cmdSlackWorkspacesRemove(
  hippoRoot: string,
  flags: Record<string, string | boolean | string[]>,
): void {
  const teamId = typeof flags['team'] === 'string' ? (flags['team'] as string).trim() : '';
  if (!teamId) {
    printError('Usage: hippo slack workspaces remove --team <T>');
    process.exit(1);
  }
  const db = openHippoDb(hippoRoot);
  try {
    const removed = removeSlackWorkspace(db, teamId);
    if (!removed) {
      printError(`no workspace registered for team ${teamId}`);
      process.exit(1);
    }
    console.log(`removed: ${teamId}`);
  } finally {
    closeHippoDb(db);
  }
}

export function cmdSlack(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (sub === 'backfill') {
    cmdSlackBackfill(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    cmdSlackDlqList(hippoRoot, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    cmdSlackDlqReplay(hippoRoot, args, flags);
    return;
  }
  if (sub === 'workspaces') {
    const action = args[1];
    if (action === 'add') {
      cmdSlackWorkspacesAdd(hippoRoot, flags);
      return;
    }
    if (action === 'list') {
      cmdSlackWorkspacesList(hippoRoot);
      return;
    }
    if (action === 'remove') {
      cmdSlackWorkspacesRemove(hippoRoot, flags);
      return;
    }
    printSlackWorkspacesUsage();
    process.exit(1);
  }
  printError(
    'Usage: hippo slack <backfill|dlq list|dlq replay <id> [--force]|workspaces add|workspaces list|workspaces remove> [...]',
  );
  process.exit(1);
}
