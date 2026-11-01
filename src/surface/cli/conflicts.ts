// `hippo conflicts` and `hippo resolve`: list the contradicting memory pairs and settle one.

import { truncateWithEllipsis } from '../../base/util/ellipsize.js';
import { conflictToWire } from '../../base/memory/conflict-wire.js';
import * as api from '../../api/index.js';
import { memoryGet } from '../../api/memories/memories.js';
import { cliApiContext } from './api-context.js';
import {
  type CommandContext,
  boolFlag,
  parsePositiveId,
  stringFlag,
  stringFlagOrExit,
} from './flag-values.js';
import { requireInit } from './shared.js';
import { fmt } from './print.js';
import { printJsonList } from './json-list.js';
import { fail } from './exit.js';

const CONFLICT_PREVIEW_CHARS = 120;

export async function handleConflicts({
  hippoRoot,
  tenantId,
  flags,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const status = stringFlagOrExit(flags, 'status') ?? 'open';
  const ctx = cliApiContext(hippoRoot, tenantId);
  const read = (page: api.ConflictPageOptions) =>
    api.conflictList(ctx, status, { everyTenant: true }, page);
  if (boolFlag(flags, 'json')) {
    await printJsonList('conflicts', wirePages(api.conflictPages(read)));
    return;
  }

  // The header leads with the count, so a list past one page is read once to count and again from
  // page 2 to print.
  let total = 0;
  let first: api.ConflictPage | undefined;
  for await (const page of api.conflictPages(read)) {
    first ??= page;
    total += page.conflicts.length;
  }
  if (first === undefined || total === 0) {
    console.log('No memory conflicts found.');
    return;
  }

  console.log(`Found ${total} memory conflict${total === 1 ? '' : 's'}\n`);
  printConflictLines(first.conflicts);
  if (first.next) {
    for await (const page of api.conflictPages(read, first.next)) {
      printConflictLines(page.conflicts);
    }
  }
}

async function* wirePages(pages: AsyncIterable<api.ConflictPage>) {
  for await (const page of pages) yield page.conflicts.map(conflictToWire);
}

function printConflictLines(conflicts: api.ConflictPage['conflicts']): void {
  for (const conflict of conflicts) {
    console.log(
      `--- conflict_${conflict.id} score=${fmt(conflict.score, 3)} status=${conflict.status}`,
    );
    console.log(`    ${conflict.memoryAId} <-> ${conflict.memoryBId}`);
    console.log(`    reason: ${conflict.reason}`);
    console.log('');
  }
}

/** Shown when --keep is missing, to help the user decide. */
async function showConflictForResolve(
  hippoRoot: string,
  conflictId: number,
  tenantId: string,
): Promise<void> {
  const ctx = cliApiContext(hippoRoot, tenantId);
  const conflict = await api.conflictGet(ctx, conflictId);
  if (!conflict || conflict.status !== 'open') {
    fail(`Conflict ${conflictId} not found or already resolved.`);
  }

  console.log(`Conflict ${conflictId}:`);
  console.log(`  ${conflict.memoryAId} <-> ${conflict.memoryBId}`);
  console.log(`  Reason: ${conflict.reason}`);
  console.log('');

  const entryA = await memoryGet(ctx, conflict.memoryAId);
  const entryB = await memoryGet(ctx, conflict.memoryBId);
  if (entryA) {
    console.log(`  [A] ${conflict.memoryAId}:`);
    console.log(`      ${truncateWithEllipsis(entryA.content, CONFLICT_PREVIEW_CHARS)}`);
  }
  if (entryB) {
    console.log(`  [B] ${conflict.memoryBId}:`);
    console.log(`      ${truncateWithEllipsis(entryB.content, CONFLICT_PREVIEW_CHARS)}`);
  }
  console.log('');
  console.log(
    `Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget] [--reject-loser [--reason "<why>"]]`,
  );
}

export async function handleResolve({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  // Accept "42" or "conflict_42"
  const idText = (args[0] ?? '').replace(/^conflict_/, '');
  if (!idText) {
    fail('Usage: hippo resolve <conflict_id> --keep <memory_id> [--forget]');
  }
  const conflictId = parsePositiveId(idText, 'conflict');

  const keepId = stringFlagOrExit(flags, 'keep') ?? '';
  if (!keepId) {
    await showConflictForResolve(hippoRoot, conflictId, tenantId);
    return;
  }

  const forgetLoser = boolFlag(flags, 'forget');
  // --reject-loser tombstones the loser's digest so it cannot be re-asserted, as well as removing
  // it. --reason is optional here, unlike `hippo reject`: resolve already has the conflict id and
  // keepId.
  const rejectLoser = boolFlag(flags, 'reject-loser');
  const reasonFlag = stringFlag(flags, 'reason');
  const result = await api.conflictResolve(cliApiContext(hippoRoot, tenantId), conflictId, {
    keepId,
    forget: forgetLoser,
    rejectLoser,
    reason: reasonFlag,
  });

  const action = rejectLoser
    ? 'rejected (tombstoned) and removed'
    : forgetLoser
      ? 'deleted'
      : 'weakened (half-life halved)';
  console.log(`Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`);
}
