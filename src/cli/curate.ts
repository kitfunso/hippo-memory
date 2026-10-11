// Verbs that weaken, suppress or retire memories: outcome, forget, conflicts, reject, dormant, quarantine, invalidate.

import { truncateWithEllipsis } from '../util/ellipsize.js';
import * as path from 'path';
import { rejectValue, unrejectValue, listRejectionsForTenant } from '../trust/reject-flow.js';
import { RejectedValueError } from '../core/api-errors.js';
import { loadConfig } from '../core/config.js';
import { RawAppendOnlyError } from '../core/raw-append-only.js';
import { isGitRepo } from '../learn/autolearn.js';
import { invalidateMatching, InvalidationTarget } from '../learn/invalidation.js';
import * as api from '../api/index.js';
import { getMemory } from '../api/memories.js';
import * as client from './client.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { type CliFlags, parseCountFlag, type CommandContext, boolFlag, flagIsTrue, nonEmptyStringFlag, stringFlag } from './flag-values.js';
import { requireInit, runChurnStaleForRepo, runViaServerIfAvailable, resolveAuthRoot } from './shared.js';
import { fmt } from './print.js';
import { errorMessage } from '../util/log.js';
import { DIGEST_DISPLAY_CHARS, CONTENT_PREVIEW_CHARS, DATE_PREFIX_CHARS } from '../util/token-text.js';
import { CliExit } from './exit.js';

const CONFLICT_PREVIEW_CHARS = 120;
const REJECTED_DIGEST_LIST_CHARS = 16;
const DORMANT_PREVIEW_CHARS = 100;
const STRENGTH_DECIMALS = 3;

export function handleOutcome({ hippoRoot, tenantId, flags }: CommandContext): void {
  requireInit(hippoRoot);

  const good = boolFlag(flags, 'good');
  const bad = boolFlag(flags, 'bad');

  if (!good && !bad) {
    printError('Specify --good or --bad');
    throw new CliExit(1);
  }

  // Through api.outcome so every CLI outcome writes one audit_log row per id, as the MCP path does.
  const ctx = cliApiContext(hippoRoot, tenantId);
  const specificId = flags['id'] ? String(flags['id']) : null;

  let updated: number;
  if (specificId) {
    updated = api.outcome(ctx, [specificId], good).applied;
  } else {
    const r = api.outcomeForLastRecall(ctx, good);
    if (r.ids.length === 0) {
      console.log('No recent recall to apply outcome to. Use --id <id> to target a specific memory.');
      return;
    }
    updated = r.applied;
  }

  console.log(`Applied ${good ? 'positive' : 'negative'} outcome to ${updated} memor${updated === 1 ? 'y' : 'ies'}`);
}

// Shared between the forget dispatch and cmdForget so the message can't drift.
const ARCHIVE_REASON_REQUIRED =
  'hippo forget --archive requires --reason "<why>" (recorded on the archive).';

function cmdForget(
  hippoRoot: string,
  tenantId: string,
  id: string,
  flags: CliFlags,
): void {
  requireInit(hippoRoot);

  const ctx = cliApiContext(hippoRoot, tenantId);

  // Raw memories (connector ingestion) are append-only: a BEFORE-DELETE trigger aborts any delete,
  // so archiveRaw is the sanctioned removal path and records ctx.actor as the archiver.
  if (flagIsTrue(flags, 'archive')) {
    archiveForgottenRaw(ctx, id, stringFlag(flags, 'reason') ?? null);
    return;
  }

  try {
    api.forget(ctx, id);
    console.log(`Forgot ${id}`);
  } catch (err) {
    reportForgetFailure(ctx, id, err);
    throw new CliExit(1);
  }
}

function archiveForgottenRaw(ctx: api.HippoDbContext, id: string, reason: string | null): void {
  if (!reason) {
    printError(ARCHIVE_REASON_REQUIRED);
    throw new CliExit(1);
  }
  try {
    api.archiveRaw(ctx, id, reason);
    console.log(`Archived ${id}`);
  } catch (err) {
    printError(`Could not archive ${id}: ${errorMessage(err)}`);
    throw new CliExit(1);
  }
}

function reportForgetFailure(ctx: api.HippoDbContext, id: string, cause: unknown): void {
  if (cause instanceof RawAppendOnlyError) {
    // The delete was refused by the append-only trigger — this is a raw
    // memory, not a missing one. Point the user at the archive path.
    printError(rawForgetRefusal(id));
  } else if (api.isDormant(ctx, id)) {
    // Sleep moved it to the dormant store: it is not in active memory, so
    // point at the command that owns it.
    printError(
      `${id} is dormant, not in active memory. Delete it for good: hippo dormant forget ${id} ` +
      `(or bring it back: hippo dormant restore ${id})`,
    );
  } else {
    printError(`Memory not found: ${id}`);
  }
}

function rawForgetRefusal(id: string): string {
  return `Cannot forget ${id}: it is a raw, append-only memory. Archive it instead: hippo forget ${id} --archive --reason "<why>"`;
}

// Refuses exactly where the real run would, so "Would forget" is a promise, not a guess.
async function previewForget(hippoRoot: string, tenantId: string, id: string, archive: boolean): Promise<void> {
  requireInit(hippoRoot);
  const entry = await getMemory(cliApiContext(hippoRoot, tenantId), id);
  if (!entry) {
    printError(`Memory not found: ${id}`);
    throw new CliExit(1);
  }
  if (!archive && entry.kind === 'raw') {
    printError(rawForgetRefusal(id));
    throw new CliExit(1);
  }
  if (archive && entry.kind !== 'raw') {
    printError(`Could not archive ${id}: memory ${id} is not raw (kind=${entry.kind})`);
    throw new CliExit(1);
  }
  const snippet = truncateWithEllipsis(entry.content, CONTENT_PREVIEW_CHARS);
  console.log(`Would ${archive ? 'archive' : 'forget'} ${id} (dry run, nothing changed): "${snippet}"`);
}

export function handleConflicts({ hippoRoot, tenantId, flags }: CommandContext): void {
  requireInit(hippoRoot);

  const conflicts = api.listConflicts(cliApiContext(hippoRoot, tenantId), String(flags['status'] ?? 'open'), { everyTenant: true });
  if (flags['json']) {
    console.log(JSON.stringify({ conflicts }, null, 2));
    return;
  }

  if (conflicts.length === 0) {
    console.log('No memory conflicts found.');
    return;
  }

  console.log(`Found ${conflicts.length} memory conflict${conflicts.length === 1 ? '' : 's'}\n`);
  for (const conflict of conflicts) {
    console.log(`--- conflict_${conflict.id} score=${fmt(conflict.score, 3)} status=${conflict.status}`);
    console.log(`    ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`    reason: ${conflict.reason}`);
    console.log('');
  }
}

/** Shown when --keep is missing, to help the user decide. */
async function showConflictForResolve(hippoRoot: string, conflictId: number, tenantId: string): Promise<void> {
  const conflicts = api.listConflicts(cliApiContext(hippoRoot, tenantId), 'open');
  const conflict = conflicts.find((c) => c.id === conflictId);
  if (!conflict) {
    printError(`Conflict ${conflictId} not found or already resolved.`);
    throw new CliExit(1);
  }

  console.log(`Conflict ${conflictId}:`);
  console.log(`  ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
  console.log(`  Reason: ${conflict.reason}`);
  console.log('');

  const ctx = cliApiContext(hippoRoot, tenantId);
  const entryA = await getMemory(ctx, conflict.memory_a_id);
  const entryB = await getMemory(ctx, conflict.memory_b_id);
  if (entryA) {
    console.log(`  [A] ${conflict.memory_a_id}:`);
    console.log(`      ${truncateWithEllipsis(entryA.content, CONFLICT_PREVIEW_CHARS)}`);
  }
  if (entryB) {
    console.log(`  [B] ${conflict.memory_b_id}:`);
    console.log(`      ${truncateWithEllipsis(entryB.content, CONFLICT_PREVIEW_CHARS)}`);
  }
  console.log('');
  console.log(`Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget] [--reject-loser [--reason "<why>"]]`);
}

export async function handleResolve({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const rawId = args[0] ?? '';
  // Accept "42" or "conflict_42"
  const conflictId = parseInt(rawId.replace(/^conflict_/, ''), 10);
  if (isNaN(conflictId)) {
    printError('Usage: hippo resolve <conflict_id> --keep <memory_id> [--forget]');
    throw new CliExit(1);
  }

  const keepId = String(flags['keep'] ?? '').trim();
  if (!keepId) {
    await showConflictForResolve(hippoRoot, conflictId, tenantId);
    return;
  }

  const forgetLoser = boolFlag(flags, 'forget');
  // --reject-loser tombstones the loser's digest so it cannot be re-asserted, as well as removing it.
  // --reason is optional here, unlike `hippo reject`: resolve already has the conflict id and keepId.
  const rejectLoser = boolFlag(flags, 'reject-loser');
  const reasonFlag = stringFlag(flags, 'reason');
  const result = api.resolveMemoryConflict(cliApiContext(hippoRoot, tenantId), conflictId, {
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

// reject / rejections / unreject

export function handleReject({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  // Store resolution mirrors `hippo remember`: --global writes to the
  // global store, otherwise the local store (requireInit'd via resolveAuthRoot).
  const root = resolveAuthRoot(hippoRoot, flags);

  // --reason is REQUIRED: the tombstone stores no content, so reason is its only human-readable identity.
  const reason = (stringFlag(flags, 'reason') ?? '').trim();
  if (!reason) {
    printError('hippo reject requires --reason "<why>" (the tombstone stores no content; reason is its only identity).');
    throw new CliExit(1);
  }

  const valueFlag = stringFlag(flags, 'value');
  const memoryId = args[0];

  if (!memoryId && valueFlag === undefined) {
    printError('Usage: hippo reject <memory-id> --reason "<why>"');
    printError('   or: hippo reject --value "<text>" --reason "<why>"');
    throw new CliExit(1);
  }
  if (memoryId && valueFlag !== undefined) {
    // Ambiguous ask: silently preferring one form would ignore the other without feedback.
    printError('hippo reject takes EITHER a memory id OR --value, not both.');
    throw new CliExit(1);
  }

  try {
    const result = rejectValue({
      hippoRoot: root,
      tenantId,
      actor: 'cli',
      reason,
      memoryId: valueFlag === undefined ? memoryId : undefined,
      value: valueFlag,
    });
    printRejected(result, reason);
  } catch (err) {
    printError(`Could not reject: ${errorMessage(err)}`);
    throw new CliExit(1);
  }
}

function printRejected(result: ReturnType<typeof rejectValue>, reason: string): void {
  const digestPrefix = result.digest.slice(0, DIGEST_DISPLAY_CHARS);
  const preview = truncateWithEllipsis(result.content, CONTENT_PREVIEW_CHARS);
  console.log(`Rejected [${digestPrefix}...]: "${preview}"`);
  console.log(`  Reason: ${reason}`);
  if (result.removedIds.length > 0) {
    console.log(`  Removed ${result.removedIds.length} matching row(s): ${result.removedIds.join(', ')}`);
    if (result.successorIds.length > 0) {
      console.log(`  Merged rows that held it keep their other texts in: ${result.successorIds.join(', ')}`);
    }
    if (result.dormantSuccessorIds.length > 0) {
      console.log(`  Dormant merged rows that held it keep their other texts in: ${result.dormantSuccessorIds.join(', ')}`);
    }
  } else {
    console.log('  No live rows matched (pre-emptive tombstone).');
  }
}

export function handleRejections({ hippoRoot, tenantId, flags }: CommandContext): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const rows = listRejectionsForTenant(root, tenantId);

  if (flags['json']) {
    console.log(JSON.stringify({ rejections: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log('No rejected values.');
    return;
  }

  console.log(`${rows.length} rejected value(s):\n`);
  for (const row of rows) {
    console.log(`--- ${row.digest.slice(0, DIGEST_DISPLAY_CHARS)}...`);
    console.log(`    Reason:       ${row.reason ?? 'none given'}`);
    console.log(`    Rejected by:  ${row.rejectedBy ?? 'unknown'}`);
    console.log(`    Rejected at:  ${row.rejectedAt}`);
    if (row.sourceMemoryId) console.log(`    Source id:    ${row.sourceMemoryId}`);
    if (row.normalizedChars !== null) console.log(`    Chars:        ${row.normalizedChars}`);
    console.log('');
  }
}

export function handleUnreject({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const digestOrPrefix = (args[0] ?? '').trim();
  if (!digestOrPrefix) {
    printError('Usage: hippo unreject <digest-or-prefix>');
    throw new CliExit(1);
  }

  const outcome = unrejectValue(root, tenantId, digestOrPrefix, 'cli');
  if (outcome.status === 'not_found') {
    printError(`No rejected value matches "${digestOrPrefix}". Run \`hippo rejections\` to list tombstones.`);
    throw new CliExit(1);
  }
  if (outcome.status === 'ambiguous') {
    printError(`"${digestOrPrefix}" matches ${outcome.candidates.length} tombstones. Use a longer prefix:`);
    for (const c of outcome.candidates) {
      printError(`  ${c.digest.slice(0, REJECTED_DIGEST_LIST_CHARS)}...  ${c.reason ?? 'none given'}`);
    }
    throw new CliExit(1);
  }

  console.log(`Unrejected [${outcome.digest.slice(0, DIGEST_DISPLAY_CHARS)}...] (was: ${outcome.reason ?? 'none given'})`);
}

/** `hippo dormant [list|restore <id>|forget <id>]`: dormant memories are what sleep keeps instead of deleting
 * (on by default; `"dormant": { "enabled": false }` in .hippo/config.json deletes instead). */
export function handleDormant({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);
  const sub = args[0];

  if (sub === 'restore' || sub === 'forget') {
    changeDormant(ctx, sub, (args[1] ?? '').trim());
    return;
  }

  const queryArgs = sub === 'list' ? args.slice(1) : args;
  const limit = parseCountFlag(flags['limit']);
  const rows = api.listDormant(ctx, {
    query: queryArgs.join(' '),
    limit: limit > 0 ? limit : undefined,
  });

  if (flags['json']) {
    console.log(JSON.stringify({ dormant: rows }, null, 2));
    return;
  }
  printDormantRows(rows, queryArgs.length > 0, root);
}

function changeDormant(ctx: api.Context, sub: 'restore' | 'forget', id: string): void {
  if (!id) {
    printError(`Usage: hippo dormant ${sub} <id>`);
    throw new CliExit(1);
  }
  try {
    if (sub === 'restore') {
      api.restoreDormant(ctx, id);
      console.log(`Restored ${id} to active memory.`);
    } else {
      api.forgetDormant(ctx, id);
      console.log(`Forgot dormant memory ${id} permanently.`);
    }
  } catch (err) {
    if (err instanceof RejectedValueError) {
      printError(`Cannot restore ${id}: its value was rejected (${err.reason ?? 'no reason given'}). Run \`hippo unreject\` first to allow it.`);
    } else {
      printError(`Could not ${sub} ${id}: ${errorMessage(err)}`);
    }
    throw new CliExit(1);
  }
}

function printDormantRows(rows: ReturnType<typeof api.listDormant>, hasQuery: boolean, root: string): void {
  if (rows.length === 0) {
    console.log(hasQuery ? 'No dormant memories match.' : 'No dormant memories.');
    if (!loadConfig(root).dormant.enabled) {
      console.log(`Sleep deletes faded memories. To keep them dormant instead, set "dormant": { "enabled": true } in ${path.join(root, 'config.json')}.`);
    }
    return;
  }

  console.log(`${rows.length} dormant memor${rows.length === 1 ? 'y' : 'ies'}${hasQuery ? ' matching' : ''} (newest first):\n`);
  for (const row of rows) {
    const preview = truncateWithEllipsis(row.content, DORMANT_PREVIEW_CHARS);
    console.log(`--- ${row.id}`);
    console.log(`    ${preview}`);
    console.log(`    Dormant since ${row.dormantAt.slice(0, DATE_PREFIX_CHARS)} (${row.reason}, strength ${row.strength.toFixed(STRENGTH_DECIMALS)})${row.tags.length > 0 ? `  tags: ${row.tags.join(', ')}` : ''}`);
    console.log('');
  }
  console.log('Bring one back: hippo dormant restore <id>   Delete for good: hippo dormant forget <id>');
}

/** `hippo quarantine [list] [--all] [--json] [--global]`, `quarantine approve <id>`, `quarantine reject <id>` (poisoning defence). */
export async function handleQuarantine({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx = cliApiContext(root, tenantId);
  const sub = args[0];

  if (sub === 'approve' || sub === 'reject') {
    await decideQuarantined(ctx, sub, (args[1] ?? '').trim());
    return;
  }

  const status = flags['all'] ? 'all' : 'pending';
  const rows = await api.quarantineList(ctx, { status });

  if (flags['json']) {
    console.log(JSON.stringify({ quarantine: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(status === 'all' ? 'No quarantined memories.' : 'No pending quarantined memories.');
    return;
  }
  printQuarantineRows(rows);
}

async function decideQuarantined(ctx: api.Context, sub: 'approve' | 'reject', id: string): Promise<void> {
  if (!id) {
    printError(`Usage: hippo quarantine ${sub} <id>`);
    throw new CliExit(1);
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
    printError(`Could not ${sub} ${id}: ${errorMessage(err)}`);
    throw new CliExit(1);
  }
}

function printQuarantineRows(rows: Awaited<ReturnType<typeof api.quarantineList>>): void {
  console.log(`${rows.length} quarantined memor${rows.length === 1 ? 'y' : 'ies'} (newest first):\n`);
  for (const row of rows) {
    console.log(`--- ${row.id} [${row.status}]`);
    console.log(`    ${row.contentPreview}`);
    console.log(`    ${row.reason}, original scope ${row.originalScope ?? '(none)'}, quarantined ${row.quarantinedAt.slice(0, DATE_PREFIX_CHARS)}`);
    console.log('');
  }
  console.log('Approve: hippo quarantine approve <id>   Reject: hippo quarantine reject <id>');
}

export async function handleForget({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    printError('Please provide a memory ID.');
    throw new CliExit(1);
  }
  // Archive has its own HTTP route (POST /v1/memories/:id/archive); route
  // both branches the same way the direct path does.
  const archive = flagIsTrue(flags, 'archive');
  const reason = stringFlag(flags, 'reason') ?? null;
  if (archive && !reason) {
    printError(ARCHIVE_REASON_REQUIRED);
    throw new CliExit(1);
  }
  if (flagIsTrue(flags, 'dry-run')) {
    await previewForget(hippoRoot, tenantId, id, archive);
    return;
  }
  const routed = await runViaServerIfAvailable(hippoRoot, async (info, apiKey) => {
    try {
      if (archive) {
        await client.archiveRaw(info.url, apiKey, id, reason!);
        console.log(`Archived ${id}`);
      } else {
        await client.forget(info.url, apiKey, id);
        console.log(`Forgot ${id}`);
      }
    } catch (err) {
      // A server that died after the health probe is the caller's transport
      // fallback to handle, not an error to report to the user.
      if (err instanceof Error && client.classifyTransportFailure(err) !== 'none') throw err;
      const msg = errorMessage(err);
      printError(archive ? `Could not archive ${id}: ${msg}` : msg);
      throw new CliExit(1);
    }
  });
  if (routed) return;
  cmdForget(hippoRoot, tenantId, id, flags);
}

function invalidateChurn(hippoRoot: string, tenantId: string, args: string[], flags: CommandContext['flags']): void {
  if (args[0] || flags['id'] !== undefined) {
    printError('Usage: hippo invalidate --churn [--dry-run]');
    printError('--churn takes no pattern or --id.');
    throw new CliExit(1);
  }
  if (!isGitRepo(process.cwd())) {
    printError('hippo invalidate --churn must run inside a git repository.');
    throw new CliExit(1);
  }
  const churnDryRun = flagIsTrue(flags, 'dry-run');
  let churnFailed = false;
  for (const { root, result } of runChurnStaleForRepo(hippoRoot, tenantId, churnDryRun)) {
    if (result.error) {
      printError(`Churn-staleness check failed for ${root}: ${result.error}`);
      churnFailed = true;
      continue;
    }
    if (result.preview.length === 0) {
      console.log(`No churn-stale candidates in ${root}.`);
    } else if (churnDryRun) {
      console.log(`DRY RUN - ${result.marked} memories in ${root} WOULD be tagged churn-stale (${result.alreadyMarked} already tagged):`);
    } else {
      console.log(`Tagged ${result.marked} memories churn-stale in ${root} (${result.alreadyMarked} already tagged):`);
    }
    result.preview.forEach(p => console.log(`   ${p.id}  ${p.evidence}  ${p.already ? '(already) ' : ''}${p.headline}`));
    if (result.skippedPinned.length > 0) {
      console.log(`Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`);
    }
  }
  if (churnFailed) throw new CliExit(1);
}

export function handleInvalidate({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  if (flagIsTrue(flags, 'churn')) return invalidateChurn(hippoRoot, tenantId, args, flags);
  const target = args[0];
  if (flagIsTrue(flags, 'id')) {
    // Value-less --id must never silently fall through to pattern mode
    // (pattern mode writes broadly; an ignored --id reverses user intent).
    printError('--id requires a memory id');
    throw new CliExit(1);
  }
  const onlyId = stringFlag(flags, 'id');
  const dryRun = flagIsTrue(flags, 'dry-run');
  if ((target && onlyId) || (!target && !onlyId)) {
    printError('Usage: hippo invalidate "<old pattern>" [--dry-run] [--reason "<why>"]');
    printError('       hippo invalidate --id <memory-id> [--dry-run] [--reason "<why>"]');
    printError('Pass a pattern OR --id, not both. Tag matching is EXACT: the full pattern must equal a tag.');
    throw new CliExit(1);
  }
  const reason = nonEmptyStringFlag(flags, 'reason') ?? null;
  const invTarget: InvalidationTarget = {
    from: target ?? `id:${onlyId}`,
    to: reason,
    type: 'migration',
  };
  const result = invalidateMatching(hippoRoot, invTarget, tenantId, { dryRun, onlyId });
  const label = target ? `"${target}"` : `--id ${onlyId}`;
  if (result.dryRun) {
    if (result.invalidated === 0) {
      console.log(`DRY RUN - no memories would match ${label}.`);
    } else {
      console.log(`DRY RUN - ${result.invalidated} memories WOULD be invalidated:`);
      result.preview.forEach(p => console.log(`   ${p.id}  ${p.headline}`));
    }
  } else if (result.invalidated === 0) {
    console.log(`No memories matched ${label}.`);
  } else {
    console.log(`Invalidated ${result.invalidated} memories referencing ${label}.`);
    result.targets.forEach(id => console.log(`   ${id}`));
  }
  if (result.skippedPinned.length > 0) {
    console.log(`Skipped ${result.skippedPinned.length} pinned: ${result.skippedPinned.join(', ')}`);
  }
}
