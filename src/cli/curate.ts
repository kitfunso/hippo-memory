// Verbs that weaken, suppress or retire memories: outcome, forget, conflicts, reject, dormant, quarantine, invalidate.

import * as path from 'path';
import { readEntry } from '../store/entry-reads.js';
import { listMemoryConflicts, resolveConflict } from '../store/conflicts.js';
import { rejectValue, unrejectValue, listRejectionsForTenant } from '../reject-flow.js';
import { RejectedValueError } from '../rejection.js';
import { loadConfig } from '../config.js';
import { isGitRepo } from '../autolearn.js';
import { invalidateMatching, InvalidationTarget } from '../invalidation.js';
import * as api from '../api.js';
import * as client from './client.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import {
  type CliFlags,
  parseCountFlag,
  requireInit,
  runChurnStaleForRepo,
  runViaServerIfAvailable,
  fmt,
  type CommandContext,
  resolveAuthRoot,
  boolFlag,
  flagIsTrue,
  stringFlag,
} from './shared.js';
import { errorMessage } from '../log.js';

export function cmdOutcome(
  hippoRoot: string,
  flags: CliFlags
): void {
  requireInit(hippoRoot);

  const good = boolFlag(flags, 'good');
  const bad = boolFlag(flags, 'bad');

  if (!good && !bad) {
    printError('Specify --good or --bad');
    process.exit(1);
  }

  // Through api.outcome so every CLI outcome writes one audit_log row per id, as the MCP path does.
  const ctx: api.HippoDbContext = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
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
  id: string,
  flags: CliFlags,
): void {
  requireInit(hippoRoot);

  const ctx: api.HippoDbContext = {
    hippoRoot,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };

  // Raw memories (Slack / GitHub connector ingestion) are append-only: a
  // BEFORE-DELETE trigger aborts any delete. archiveRaw is the sanctioned
  // removal path; it records ctx.actor as the archiver for provenance.
  if (flagIsTrue(flags, 'archive')) {
    const reason = stringFlag(flags, 'reason') ?? null;
    if (!reason) {
      printError(ARCHIVE_REASON_REQUIRED);
      process.exit(1);
    }
    try {
      api.archiveRaw(ctx, id, reason);
      console.log(`Archived ${id}`);
    } catch (err) {
      printError(`Could not archive ${id}: ${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  try {
    api.forget(ctx, id);
    console.log(`Forgot ${id}`);
  } catch (err) {
    const msg = errorMessage(err);
    if (/append-only/i.test(msg)) {
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
    process.exit(1);
  }
}

function rawForgetRefusal(id: string): string {
  return `Cannot forget ${id}: it is a raw, append-only memory. Archive it instead: hippo forget ${id} --archive --reason "<why>"`;
}

// Refuses exactly where the real run would, so "Would forget" is a promise, not a guess.
function previewForget(hippoRoot: string, id: string, archive: boolean): void {
  requireInit(hippoRoot);
  const entry = readEntry(hippoRoot, id, resolveTenantId({}));
  if (!entry) {
    printError(`Memory not found: ${id}`);
    process.exit(1);
  }
  if (!archive && entry.kind === 'raw') {
    printError(rawForgetRefusal(id));
    process.exit(1);
  }
  if (archive && entry.kind !== 'raw') {
    printError(`Could not archive ${id}: memory ${id} is not raw (kind=${entry.kind})`);
    process.exit(1);
  }
  const snippet = entry.content.length > 80 ? `${entry.content.slice(0, 80)}...` : entry.content;
  console.log(`Would ${archive ? 'archive' : 'forget'} ${id} (dry run, nothing changed): "${snippet}"`);
}

export function cmdConflicts(
  hippoRoot: string,
  flags: CliFlags
): void {
  requireInit(hippoRoot);

  const conflicts = listMemoryConflicts(hippoRoot, String(flags['status'] ?? 'open'));
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

export function cmdResolve(
  hippoRoot: string,
  args: string[],
  flags: CliFlags
): void {
  requireInit(hippoRoot);

  const rawId = args[0] ?? '';
  // Accept "42" or "conflict_42"
  const conflictId = parseInt(rawId.replace(/^conflict_/, ''), 10);
  if (isNaN(conflictId)) {
    printError('Usage: hippo resolve <conflict_id> --keep <memory_id> [--forget]');
    process.exit(1);
  }

  const tenantId = resolveTenantId({});
  const keepId = String(flags['keep'] ?? '').trim();
  if (!keepId) {
    // Show the conflict details to help the user decide
    const conflicts = listMemoryConflicts(hippoRoot, 'open', tenantId);
    const conflict = conflicts.find((c) => c.id === conflictId);
    if (!conflict) {
      printError(`Conflict ${conflictId} not found or already resolved.`);
      process.exit(1);
    }

    console.log(`Conflict ${conflictId}:`);
    console.log(`  ${conflict.memory_a_id} <-> ${conflict.memory_b_id}`);
    console.log(`  Reason: ${conflict.reason}`);
    console.log('');

    const entryA = readEntry(hippoRoot, conflict.memory_a_id, tenantId);
    const entryB = readEntry(hippoRoot, conflict.memory_b_id, tenantId);
    if (entryA) {
      console.log(`  [A] ${conflict.memory_a_id}:`);
      console.log(`      ${entryA.content.slice(0, 120)}${entryA.content.length > 120 ? '...' : ''}`);
    }
    if (entryB) {
      console.log(`  [B] ${conflict.memory_b_id}:`);
      console.log(`      ${entryB.content.slice(0, 120)}${entryB.content.length > 120 ? '...' : ''}`);
    }
    console.log('');
    console.log(`Resolve with: hippo resolve ${conflictId} --keep <memory_id> [--forget] [--reject-loser [--reason "<why>"]]`);
    return;
  }

  const forgetLoser = boolFlag(flags, 'forget');
  // --reject-loser tombstones the loser's digest so it cannot be re-asserted, as well as removing it.
  // --reason is optional here, unlike `hippo reject`: resolve already has the conflict id and keepId.
  const rejectLoser = boolFlag(flags, 'reject-loser');
  const reasonFlag = stringFlag(flags, 'reason');
  const result = resolveConflict(hippoRoot, conflictId, keepId, forgetLoser, tenantId, {
    rejectLoserValue: rejectLoser,
    reason: reasonFlag,
  });

  if (!result) {
    printError(`Could not resolve conflict ${conflictId}. Check the ID and --keep value.`);
    process.exit(1);
  }

  const action = rejectLoser
    ? 'rejected (tombstoned) and removed'
    : forgetLoser
      ? 'deleted'
      : 'weakened (half-life halved)';
  console.log(`Resolved conflict ${conflictId}: kept ${keepId}, ${action} ${result.loserId}`);
}

// ---------------------------------------------------------------------------
// reject / rejections / unreject
// ---------------------------------------------------------------------------

export function cmdReject(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
): void {
  // Store resolution mirrors `hippo remember`: --global writes to the
  // global store, otherwise the local store (requireInit'd via resolveAuthRoot).
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});

  // --reason is REQUIRED: the tombstone stores no content, so reason is its only human-readable identity.
  const reason = (stringFlag(flags, 'reason') ?? '').trim();
  if (!reason) {
    printError('hippo reject requires --reason "<why>" (the tombstone stores no content; reason is its only identity).');
    process.exit(1);
  }

  const valueFlag = stringFlag(flags, 'value');
  const memoryId = args[0];

  if (!memoryId && valueFlag === undefined) {
    printError('Usage: hippo reject <memory-id> --reason "<why>"');
    printError('   or: hippo reject --value "<text>" --reason "<why>"');
    process.exit(1);
  }
  if (memoryId && valueFlag !== undefined) {
    // Ambiguous ask: silently preferring one form would ignore the other without feedback.
    printError('hippo reject takes EITHER a memory id OR --value, not both.');
    process.exit(1);
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
    const digestPrefix = result.digest.slice(0, 12);
    const preview = result.content.length > 80 ? `${result.content.slice(0, 80)}...` : result.content;
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
  } catch (err) {
    printError(`Could not reject: ${errorMessage(err)}`);
    process.exit(1);
  }
}

export function cmdRejections(
  hippoRoot: string,
  flags: CliFlags,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});
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
    console.log(`--- ${row.digest.slice(0, 12)}...`);
    console.log(`    Reason:       ${row.reason ?? 'none given'}`);
    console.log(`    Rejected by:  ${row.rejectedBy ?? 'unknown'}`);
    console.log(`    Rejected at:  ${row.rejectedAt}`);
    if (row.sourceMemoryId) console.log(`    Source id:    ${row.sourceMemoryId}`);
    if (row.normalizedChars !== null) console.log(`    Chars:        ${row.normalizedChars}`);
    console.log('');
  }
}

export function cmdUnreject(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const tenantId = resolveTenantId({});
  const digestOrPrefix = (args[0] ?? '').trim();
  if (!digestOrPrefix) {
    printError('Usage: hippo unreject <digest-or-prefix>');
    process.exit(1);
  }

  const outcome = unrejectValue(root, tenantId, digestOrPrefix, 'cli');
  if (outcome.status === 'not_found') {
    printError(`No rejected value matches "${digestOrPrefix}". Run \`hippo rejections\` to list tombstones.`);
    process.exit(1);
  }
  if (outcome.status === 'ambiguous') {
    printError(`"${digestOrPrefix}" matches ${outcome.candidates.length} tombstones. Use a longer prefix:`);
    for (const c of outcome.candidates) {
      printError(`  ${c.digest.slice(0, 16)}...  ${c.reason ?? 'none given'}`);
    }
    process.exit(1);
  }

  console.log(`Unrejected [${outcome.digest.slice(0, 12)}...] (was: ${outcome.reason ?? 'none given'})`);
}

/**
 * `hippo dormant [list] [<query>...] [--limit <n>] [--json] [--global]`,
 * `hippo dormant restore <id>`, `hippo dormant forget <id>`.
 * Dormant memories are what sleep keeps instead of deleting (on by default;
 * `"dormant": { "enabled": false }` in .hippo/config.json deletes instead).
 */
export function cmdDormant(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const sub = args[0];

  if (sub === 'restore' || sub === 'forget') {
    const id = (args[1] ?? '').trim();
    if (!id) {
      printError(`Usage: hippo dormant ${sub} <id>`);
      process.exit(1);
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
      process.exit(1);
    }
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
  if (rows.length === 0) {
    console.log(queryArgs.length > 0 ? 'No dormant memories match.' : 'No dormant memories.');
    if (!loadConfig(root).dormant.enabled) {
      console.log(`Sleep deletes faded memories. To keep them dormant instead, set "dormant": { "enabled": true } in ${path.join(root, 'config.json')}.`);
    }
    return;
  }

  console.log(`${rows.length} dormant memor${rows.length === 1 ? 'y' : 'ies'}${queryArgs.length > 0 ? ' matching' : ''} (newest first):\n`);
  for (const row of rows) {
    const preview = row.content.length > 100 ? `${row.content.slice(0, 100)}...` : row.content;
    console.log(`--- ${row.id}`);
    console.log(`    ${preview}`);
    console.log(`    Dormant since ${row.dormantAt.slice(0, 10)} (${row.reason}, strength ${row.strength.toFixed(3)})${row.tags.length > 0 ? `  tags: ${row.tags.join(', ')}` : ''}`);
    console.log('');
  }
  console.log('Bring one back: hippo dormant restore <id>   Delete for good: hippo dormant forget <id>');
}

/** `hippo quarantine [list] [--all] [--json] [--global]`, `quarantine approve <id>`, `quarantine reject <id>` (poisoning defence). */
export function cmdQuarantine(
  hippoRoot: string,
  args: string[],
  flags: CliFlags,
): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const ctx: api.Context = {
    hippoRoot: root,
    tenantId: resolveTenantId({}),
    actor: api.adminActor('cli'),
  };
  const sub = args[0];

  if (sub === 'approve' || sub === 'reject') {
    const id = (args[1] ?? '').trim();
    if (!id) {
      printError(`Usage: hippo quarantine ${sub} <id>`);
      process.exit(1);
    }
    try {
      if (sub === 'approve') {
        api.quarantineApprove(ctx, id);
        console.log(`Approved ${id}: restored to its original scope.`);
      } else {
        api.quarantineReject(ctx, id);
        console.log(`Rejected ${id}: stays quarantined.`);
      }
    } catch (err) {
      printError(`Could not ${sub} ${id}: ${errorMessage(err)}`);
      process.exit(1);
    }
    return;
  }

  const status = flags['all'] ? 'all' : 'pending';
  const rows = api.quarantineList(ctx, { status });

  if (flags['json']) {
    console.log(JSON.stringify({ quarantine: rows }, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(status === 'all' ? 'No quarantined memories.' : 'No pending quarantined memories.');
    return;
  }

  console.log(`${rows.length} quarantined memor${rows.length === 1 ? 'y' : 'ies'} (newest first):\n`);
  for (const row of rows) {
    console.log(`--- ${row.id} [${row.status}]`);
    console.log(`    ${row.contentPreview}`);
    console.log(`    ${row.reason}, original scope ${row.originalScope ?? '(none)'}, quarantined ${row.quarantinedAt.slice(0, 10)}`);
    console.log('');
  }
  console.log('Approve: hippo quarantine approve <id>   Reject: hippo quarantine reject <id>');
}

export async function handleForget({ hippoRoot, args, flags }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    printError('Please provide a memory ID.');
    process.exit(1);
  }
  // Archive has its own HTTP route (POST /v1/memories/:id/archive); route
  // both branches the same way the direct path does.
  const archive = flagIsTrue(flags, 'archive');
  const reason = stringFlag(flags, 'reason') ?? null;
  if (archive && !reason) {
    printError(ARCHIVE_REASON_REQUIRED);
    process.exit(1);
  }
  if (flagIsTrue(flags, 'dry-run')) {
    previewForget(hippoRoot, id, archive);
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
      if (client.classifyTransportFailure(err) !== 'none') throw err;
      const msg = errorMessage(err);
      printError(archive ? `Could not archive ${id}: ${msg}` : msg);
      process.exit(1);
    }
  });
  if (routed) return;
  cmdForget(hippoRoot, id, flags);
}

function invalidateChurn(hippoRoot: string, args: string[], flags: CommandContext['flags']): void {
  if (args[0] || flags['id'] !== undefined) {
    printError('Usage: hippo invalidate --churn [--dry-run]');
    printError('--churn takes no pattern or --id.');
    process.exit(1);
  }
  if (!isGitRepo(process.cwd())) {
    printError('hippo invalidate --churn must run inside a git repository.');
    process.exit(1);
  }
  const churnDryRun = flagIsTrue(flags, 'dry-run');
  let churnFailed = false;
  for (const { root, result } of runChurnStaleForRepo(hippoRoot, churnDryRun)) {
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
  if (churnFailed) process.exit(1);
}

export function handleInvalidate({ hippoRoot, args, flags }: CommandContext): void {
  requireInit(hippoRoot);
  if (flagIsTrue(flags, 'churn')) return invalidateChurn(hippoRoot, args, flags);
  const target = args[0];
  if (flagIsTrue(flags, 'id')) {
    // Value-less --id must never silently fall through to pattern mode
    // (pattern mode writes broadly; an ignored --id reverses user intent).
    printError('--id requires a memory id');
    process.exit(1);
  }
  const onlyId = stringFlag(flags, 'id');
  const dryRun = flagIsTrue(flags, 'dry-run');
  if ((target && onlyId) || (!target && !onlyId)) {
    printError('Usage: hippo invalidate "<old pattern>" [--dry-run] [--reason "<why>"]');
    printError('       hippo invalidate --id <memory-id> [--dry-run] [--reason "<why>"]');
    printError('Pass a pattern OR --id, not both. Tag matching is EXACT: the full pattern must equal a tag.');
    process.exit(1);
  }
  const reason = (flags['reason'] || null) as string | null;
  const invTarget: InvalidationTarget = {
    from: target ?? `id:${onlyId}`,
    to: reason,
    type: 'migration',
  };
  const result = invalidateMatching(hippoRoot, invTarget, resolveTenantId({}), { dryRun, onlyId });
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
