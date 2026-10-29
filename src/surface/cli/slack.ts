// `hippo slack`: backfill, dead-letter queue and workspace registry for the Slack connector.

import {
  envSlackAllowUnknownTeamFallback,
  envSlackBotToken,
  envSlackSigningSecret,
  envSlackTeamId,
} from '../../base/util/env.js';
import * as api from '../../api/index.js';
import { listDlq } from '../../api/dead-letters.js';
import { replaySlackDlqEntry, slackDlq } from '../connectors/slack/dlq.js';
import { backfillChannel } from '../connectors/slack/backfill.js';
import { slackHistoryFetcher } from '../connectors/slack/web-client.js';
import {
  addWorkspace as addSlackWorkspace,
  listWorkspaces as listSlackWorkspaces,
  removeWorkspace as removeSlackWorkspace,
} from '../connectors/slack/workspaces.js';
import { printError } from './output.js';
import { printSlackBackfillUsage, printSlackWorkspacesUsage } from './usage.js';
import { stringFlag, type CommandContext } from './flag-values.js';
import { runDlqReplay } from './dlq-replay.js';
import { CliExit, fail } from './exit.js';
import { errorMessage } from '../../base/util/log.js';
import type { CliCommand } from './api-context.js';

async function backfillSlack({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const channel = stringFlag(flags, 'channel');
  if (!channel) {
    printSlackBackfillUsage();
    throw new CliExit(1);
  }
  // Real fetcher requires SLACK_BOT_TOKEN with channels:history scope.
  const token = envSlackBotToken();
  if (!token) {
    printError(
      'SLACK_BOT_TOKEN is not set. Backfill requires a Slack bot token with channels:history scope.',
    );
    throw new CliExit(2);
  }
  // The slack_cursors row drives resume, so the loop always continues where it left off (keeps
  // idempotency clean).
  if (stringFlag(flags, 'since')) {
    printError('note: --since is ignored; the backfill resumes from the saved cursor.');
  }
  const fetcher = slackHistoryFetcher(token);
  const ctx = {
    ...cli.apiContext(hippoRoot, tenantId),
    actor: api.adminActor('cli:slack-backfill'),
  };
  try {
    const r = await backfillChannel(ctx, {
      teamId: envSlackTeamId() ?? 'T_UNKNOWN',
      channel: { id: channel, is_private: false },
      fetcher,
    });
    console.log(`backfill ${channel}: ${r.ingested} new messages across ${r.pages} pages`);
  } catch (e) {
    printError('backfill failed:', errorMessage(e));
    throw new CliExit(3);
  }
}

async function listSlackDlq({ cli, hippoRoot, tenantId }: CommandContext): Promise<void> {
  const items = await listDlq(cli.apiContext(hippoRoot, tenantId), slackDlq);
  for (const it of items) {
    console.log(`${it.id}\t${it.receivedAt}\t${it.error}`);
  }
}

async function replaySlackDlq({
  cli,
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const ctx = cli.apiContext(hippoRoot, tenantId);
  await runDlqReplay('slack', args[2], flags, (id, force) =>
    replaySlackDlqEntry(ctx, id, {
      force,
      signingSecret: envSlackSigningSecret(),
      allowUnknownTeamFallback: envSlackAllowUnknownTeamFallback(),
    }),
  );
}

async function registerSlackWorkspace({ cli, hippoRoot, flags }: CommandContext): Promise<void> {
  const teamId = (stringFlag(flags, 'team') ?? '').trim();
  const tenantId = (stringFlag(flags, 'tenant') ?? '').trim();
  if (!teamId || !tenantId) {
    fail('Usage: hippo slack workspaces add --team <T> --tenant <t>');
  }
  const ws = await addSlackWorkspace(cli.store(hippoRoot), { teamId, tenantId });
  console.log(`added: ${ws.teamId} -> ${ws.tenantId} (${ws.addedAt})`);
}

async function printSlackWorkspaces(cli: CliCommand, hippoRoot: string): Promise<void> {
  const items = await listSlackWorkspaces(cli.store(hippoRoot));
  if (items.length === 0) {
    console.log('(no registered workspaces; routing via HIPPO_TENANT fallback)');
    return;
  }
  for (const ws of items) {
    console.log(`${ws.teamId}\t${ws.tenantId}\t${ws.addedAt}`);
  }
}

async function unregisterSlackWorkspace({ cli, hippoRoot, flags }: CommandContext): Promise<void> {
  const teamId = (stringFlag(flags, 'team') ?? '').trim();
  if (!teamId) {
    fail('Usage: hippo slack workspaces remove --team <T>');
  }
  const removed = await removeSlackWorkspace(cli.store(hippoRoot), teamId);
  if (!removed) {
    fail(`no workspace registered for team ${teamId}`);
  }
  console.log(`removed: ${teamId}`);
}

export async function handleSlack(cmd: CommandContext): Promise<void> {
  const { hippoRoot, args, cli } = cmd;
  const sub = args[0];
  if (sub === 'backfill') {
    await backfillSlack(cmd);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    await listSlackDlq(cmd);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await replaySlackDlq(cmd);
    return;
  }
  if (sub === 'workspaces') {
    const action = args[1];
    if (action === 'add') {
      await registerSlackWorkspace(cmd);
      return;
    }
    if (action === 'list') {
      await printSlackWorkspaces(cli, hippoRoot);
      return;
    }
    if (action === 'remove') {
      await unregisterSlackWorkspace(cmd);
      return;
    }
    printSlackWorkspacesUsage();
    throw new CliExit(1);
  }
  fail(
    'Usage: hippo slack <backfill|dlq list|dlq replay <id> [--force]|workspaces add|workspaces list|workspaces remove> [...]',
  );
}
