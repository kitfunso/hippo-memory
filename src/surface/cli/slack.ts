// `hippo slack`: backfill, dead-letter queue and workspace registry for the Slack connector.

import {
  envSlackAllowUnknownTeamFallback,
  envSlackBotToken,
  envSlackSigningSecret,
  envSlackTeamId,
} from '../../base/util/env.js';
import * as api from '../../api/index.js';
import { listDlq } from '../connectors/dlq.js';
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
import { type CliFlags, stringFlag, type CommandContext } from './flag-values.js';
import { runDlqReplay } from './dlq-replay.js';
import { CLI_ACTOR } from '../../base/scope/actor.js';
import { cliConnectorSource, type ConnectorSource } from './connector-source.js';
import { CliExit, fail } from './exit.js';
import { errorMessage } from '../../base/util/log.js';

async function backfillSlack(source: ConnectorSource, flags: CliFlags): Promise<void> {
  const channel = stringFlag(flags, 'channel');
  if (!channel) {
    printSlackBackfillUsage();
    throw new CliExit(1);
  }
  const token = envSlackBotToken();
  if (!token) {
    printError(
      'SLACK_BOT_TOKEN is not set. Backfill requires a Slack bot token with channels:history scope.',
    );
    throw new CliExit(2);
  }
  if (stringFlag(flags, 'since')) {
    printError('note: --since is ignored; the backfill resumes from the saved cursor.');
  }
  const fetcher = slackHistoryFetcher(token);
  const ctx = source.context(api.adminActor('cli:slack-backfill'));
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

async function listSlackDlq(source: ConnectorSource): Promise<void> {
  const items = await listDlq(slackDlq, source.store(), { tenantId: source.tenantId });
  for (const it of items) {
    console.log(`${it.id}\t${it.receivedAt}\t${it.error}`);
  }
}

async function replaySlackDlq(
  source: ConnectorSource,
  args: readonly string[],
  flags: CliFlags,
): Promise<void> {
  const ctx = source.context(api.adminActor(CLI_ACTOR));
  await runDlqReplay('slack', args[2], flags, (id, force) =>
    replaySlackDlqEntry(ctx, id, {
      force,
      signingSecret: envSlackSigningSecret(),
      allowUnknownTeamFallback: envSlackAllowUnknownTeamFallback(),
    }),
  );
}

async function registerSlackWorkspace(source: ConnectorSource, flags: CliFlags): Promise<void> {
  const teamId = (stringFlag(flags, 'team') ?? '').trim();
  const tenantId = (stringFlag(flags, 'tenant') ?? '').trim();
  if (!teamId || !tenantId) {
    fail('Usage: hippo slack workspaces add --team <T> --tenant <t>');
  }
  const ws = await addSlackWorkspace(source.store(), { teamId, tenantId });
  console.log(`added: ${ws.teamId} -> ${ws.tenantId} (${ws.addedAt})`);
}

async function printSlackWorkspaces(source: ConnectorSource): Promise<void> {
  const items = await listSlackWorkspaces(source.store());
  if (items.length === 0) {
    console.log('(no registered workspaces; routing via HIPPO_TENANT fallback)');
    return;
  }
  for (const ws of items) {
    console.log(`${ws.teamId}\t${ws.tenantId}\t${ws.addedAt}`);
  }
}

async function unregisterSlackWorkspace(source: ConnectorSource, flags: CliFlags): Promise<void> {
  const teamId = (stringFlag(flags, 'team') ?? '').trim();
  if (!teamId) {
    fail('Usage: hippo slack workspaces remove --team <T>');
  }
  const removed = await removeSlackWorkspace(source.store(), teamId);
  if (!removed) {
    fail(`no workspace registered for team ${teamId}`);
  }
  console.log(`removed: ${teamId}`);
}

export async function runSlack(
  source: ConnectorSource,
  args: readonly string[],
  flags: CliFlags,
): Promise<void> {
  const sub = args[0];
  if (sub === 'backfill') {
    await backfillSlack(source, flags);
    return;
  }
  if (sub === 'dlq' && args[1] === 'list') {
    await listSlackDlq(source);
    return;
  }
  if (sub === 'dlq' && args[1] === 'replay') {
    await replaySlackDlq(source, args, flags);
    return;
  }
  if (sub === 'workspaces') {
    const action = args[1];
    if (action === 'add') {
      await registerSlackWorkspace(source, flags);
      return;
    }
    if (action === 'list') {
      await printSlackWorkspaces(source);
      return;
    }
    if (action === 'remove') {
      await unregisterSlackWorkspace(source, flags);
      return;
    }
    printSlackWorkspacesUsage();
    throw new CliExit(1);
  }
  fail(
    'Usage: hippo slack <backfill|dlq list|dlq replay <id> [--force]|workspaces add|workspaces list|workspaces remove> [...]',
  );
}

export function handleSlack({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  return runSlack(cliConnectorSource(hippoRoot, tenantId), args, flags);
}
