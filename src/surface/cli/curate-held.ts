// `hippo dormant` and `hippo quarantine`: list the dormant and quarantined memories, set aside from
// recall, that wait on one decision, and apply it.

import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import * as path from 'node:path';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import * as api from '../../api/index.js';
import type { ContextWith } from '../../api/types.js';
import { cliConfig, cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { type CommandContext, boolFlag, parseCountFlag } from './flag-values.js';
import { resolveAuthRoot } from './shared.js';
import { errorMessage } from '../../base/util/log.js';
import { DATE_PREFIX_CHARS } from '../../base/util/token-text.js';
import { CliExit, fail } from './exit.js';

const DORMANT_PREVIEW_CHARS = 100;

const STRENGTH_DECIMALS = 3;

/** `hippo dormant [list|restore <id>|forget <id>]`: dormant memories are what sleep keeps
 * instead of deleting (on by default; `"dormant": { "enabled": false }` in .hippo/config.json
 * deletes instead). */
export async function handleDormant({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);
  const sub = args[0];

  if (sub === 'restore' || sub === 'forget') {
    await changeDormant(ctx, sub, (args[1] ?? '').trim());
    return;
  }

  const queryArgs = sub === 'list' ? args.slice(1) : args;
  const limit = parseCountFlag(flags, 'limit');
  const rows = await api.dormantList(ctx, {
    query: queryArgs.join(' '),
    limit: limit > 0 ? limit : undefined,
  });

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ dormant: rows }, null, 2));
    return;
  }
  printDormantRows(rows, queryArgs.length > 0, root);
}

async function changeDormant(
  ctx: ContextWith<'dormant'>,
  sub: 'restore' | 'forget',
  id: string,
): Promise<void> {
  if (!id) {
    fail(`Usage: hippo dormant ${sub} <id>`);
  }
  try {
    if (sub === 'restore') {
      await api.dormantRestore(ctx, id);
      console.log(`Restored ${id} to active memory.`);
    } else {
      await api.dormantForget(ctx, id);
      console.log(`Forgot dormant memory ${id} permanently.`);
    }
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(
        `Cannot restore ${id}: its value was rejected (${err.reason ?? 'no reason given'}). ` +
          'Run `hippo unreject` first to allow it.',
      );
    } else {
      printError(`Could not ${sub} ${id}: ${errorMessage(err)}`);
    }
    throw new CliExit(1);
  }
}

function printDormantRows(
  rows: Awaited<ReturnType<typeof api.dormantList>>,
  hasQuery: boolean,
  root: string,
): void {
  if (rows.length === 0) {
    console.log(hasQuery ? 'No dormant memories match.' : 'No dormant memories.');
    if (!cliConfig(root).dormant.enabled) {
      console.log(
        'Sleep deletes faded memories. To keep them dormant instead, set "dormant": { "enabled": true } in ' +
          `${path.join(root, 'config.json')}.`,
      );
    }
    return;
  }

  console.log(
    `${rows.length} dormant memor${rows.length === 1 ? 'y' : 'ies'}${hasQuery ? ' matching' : ''} (newest first):\n`,
  );
  for (const row of rows) {
    const preview = truncateWithEllipsis(row.content, DORMANT_PREVIEW_CHARS);
    console.log(`--- ${row.id}`);
    console.log(`    ${preview}`);
    console.log(
      `    Dormant since ${row.dormantAt.slice(0, DATE_PREFIX_CHARS)} ` +
        `(${row.reason}, strength ${row.strength.toFixed(STRENGTH_DECIMALS)})` +
        `${row.tags.length > 0 ? `  tags: ${row.tags.join(', ')}` : ''}`,
    );
    console.log('');
  }
  console.log(
    'Bring one back: hippo dormant restore <id>   Delete for good: hippo dormant forget <id>',
  );
}

/** `hippo quarantine [list] [--all] [--json] [--global]`, `quarantine approve <id>`, `quarantine
 * reject <id>` (poisoning defence). */
export async function handleQuarantine({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);
  const sub = args[0];

  if (sub === 'approve' || sub === 'reject') {
    await decideQuarantined(ctx, sub, (args[1] ?? '').trim());
    return;
  }

  const status = boolFlag(flags, 'all') ? 'all' : 'pending';
  const rows = await api.quarantineList(ctx, { status });

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ quarantine: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(status === 'all' ? 'No quarantined memories.' : 'No pending quarantined memories.');
    return;
  }
  printQuarantineRows(rows);
}

async function decideQuarantined(
  ctx: ContextWith<'quarantine'>,
  sub: 'approve' | 'reject',
  id: string,
): Promise<void> {
  if (!id) {
    fail(`Usage: hippo quarantine ${sub} <id>`);
  }
  try {
    if (sub === 'approve') {
      await api.quarantineApprove(ctx, id);
      console.log(`Approved ${id}: restored to its original scope.`);
    } else {
      await api.quarantineReject(ctx, id);
      console.log(`Rejected ${id}: stays quarantined.`);
    }
  } catch (err) {
    fail(`Could not ${sub} ${id}: ${errorMessage(err)}`);
  }
}

function printQuarantineRows(rows: Awaited<ReturnType<typeof api.quarantineList>>): void {
  console.log(
    `${rows.length} quarantined memor${rows.length === 1 ? 'y' : 'ies'} (newest first):\n`,
  );
  for (const row of rows) {
    console.log(`--- ${row.id} [${row.status}]`);
    console.log(`    ${row.contentPreview}`);
    console.log(
      `    ${row.reason}, original scope ${row.originalScope ?? '(none)'}, ` +
        `quarantined ${row.quarantinedAt.slice(0, DATE_PREFIX_CHARS)}`,
    );
    console.log('');
  }
  console.log('Approve: hippo quarantine approve <id>   Reject: hippo quarantine reject <id>');
}
