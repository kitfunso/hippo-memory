// `hippo audit`: list and prune the audit log.

import { loadAllEntries } from '../store/entry-reads.js';
import { memoriesBackingObjects } from '../store/delete-and-batch.js';
import { auditMemories, AUDIT_OPS, type AuditEvent, type AuditOp } from '../store/audit.js';
import * as api from '../api/index.js';
import { pruneAuditLog, parseOlderThanFlag } from './audit-prune.js';
import { printError } from './output.js';
import { cliApiContext } from './api-context.js';
import { type CliFlags, type CommandContext, boolFlag, flagIsTrue, isBooleanFlag, stringFlag } from './flag-values.js';
import { requireInit, resolveAuthRoot } from './shared.js';
import { repairAutomaticMemories } from '../store/quality-repair.js';
import { getGlobalRoot } from '../sharing/global-store.js';
import { errorMessage } from '../util/log.js';
import { CliExit } from './exit.js';

// ---------------------------------------------------------------------------
// Audit log subcommands (`hippo audit list`)
// ---------------------------------------------------------------------------

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>(AUDIT_OPS);

function formatAuditRow(ev: AuditEvent): string {
  const target = ev.targetId ?? '-';
  const meta = JSON.stringify(ev.metadata ?? {});
  return `${ev.ts}  ${ev.actor}  ${ev.op}  ${target}  ${meta}`;
}

function readAuditOp(flags: CliFlags): AuditOp | undefined {
  const opFlag = stringFlag(flags, 'op');
  // SAFETY: Set.has only compares by value, so a string outside the audit ops is a plain miss.
  if (opFlag && !VALID_AUDIT_OPS.has(opFlag as AuditOp)) {
    // Built from the Set so the message cannot drift from the valid ops.
    const expected = Array.from(VALID_AUDIT_OPS).join(' | ');
    printError(`Unknown --op value: ${opFlag}. Expected one of: ${expected}.`);
    throw new CliExit(1);
  }
  // SAFETY: the exit above rejects every non-empty opFlag outside VALID_AUDIT_OPS, and an empty one is returned as given.
  return opFlag as AuditOp | undefined;
}

function readAuditLimit(flags: CliFlags): number {
  const limitRaw = flags['limit'];
  let limit = 100;
  if (limitRaw !== undefined && !isBooleanFlag(limitRaw)) {
    const parsed = parseInt(String(limitRaw), 10);
    if (!Number.isFinite(parsed)) {
      printError(`Invalid --limit value: ${String(limitRaw)} (expected a positive integer).`);
      throw new CliExit(1);
    }
    limit = parsed;
  }
  if (limit < 1 || limit > 10000) {
    printError(`--limit must be between 1 and 10000 (got ${limit}).`);
    throw new CliExit(1);
  }
  return limit;
}

async function cmdAuditList(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const root = resolveAuthRoot(hippoRoot, flags);
  const asJson = boolFlag(flags, 'json');

  const op = readAuditOp(flags);

  const since = stringFlag(flags, 'since');
  if (since !== undefined && !Number.isFinite(new Date(since).getTime())) {
    printError(`Invalid --since: ${since} (expected an ISO timestamp like 2026-04-22 or 2026-04-22T12:00:00Z).`);
    throw new CliExit(1);
  }

  const limit = readAuditLimit(flags);

  const ctx: api.Context = { hippoRoot: root, tenantId, actor: { subject: 'cli', role: 'admin' } };
  const events = await api.auditList(ctx, { op, since, limit });

  if (asJson) {
    console.log(JSON.stringify(events));
    return;
  }

  if (events.length === 0) {
    console.log('No audit events.');
    return;
  }

  console.log('ts  actor  op  target_id  metadata');
  for (const ev of events) {
    console.log(formatAuditRow(ev));
  }
}

function cmdAuditPrune(hippoRoot: string, ctxTenantId: string, flags: CliFlags): void {
  const olderThanRaw = stringFlag(flags, 'older-than') ?? '';
  if (!olderThanRaw) {
    printError('Usage: hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>]');
    throw new CliExit(1);
  }
  let olderThanDays: number;
  try {
    olderThanDays = parseOlderThanFlag(olderThanRaw);
  } catch (e) {
    printError(errorMessage(e));
    throw new CliExit(1);
  }
  const tenantId = stringFlag(flags, 'tenant')?.trim() || ctxTenantId;
  const dryRun = flagIsTrue(flags, 'dry-run');
  const asJson = boolFlag(flags, 'json');

  const result = pruneAuditLog(hippoRoot, { olderThanDays, tenantId, dryRun, actor: 'cli' });

  if (asJson) {
    console.log(JSON.stringify(result));
    return;
  }
  const verb = dryRun ? 'would delete' : 'deleted';
  console.log(`audit prune: ${verb} ${result.count} row${result.count === 1 ? '' : 's'} for tenant "${tenantId}" with ts < ${result.cutoff}`);
  if (dryRun) {
    console.log('(dry-run; re-run without --dry-run to actually delete)');
  }
}

async function cmdAuditLog(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const sub = args[0];
  if (sub === 'list') {
    await cmdAuditList(hippoRoot, tenantId, flags);
    return;
  }
  if (sub === 'prune') {
    cmdAuditPrune(hippoRoot, tenantId, flags);
    return;
  }
  printError(`Unknown audit subcommand: ${sub}. Expected: list | prune.`);
  throw new CliExit(1);
}

function auditRepair(hippoRoot: string, tenantId: string, flags: CliFlags): void {
  const apply = flagIsTrue(flags, 'apply') && flags['dry-run'] !== true;
  const result = repairAutomaticMemories(flags['global'] ? getGlobalRoot() : hippoRoot, { tenantId, apply });
  if (flags['json']) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Quality repair ${apply ? 'apply' : 'preview'}: ${result.issues.length} issue(s) across ${result.total} memories.`);
  for (const issue of result.issues) console.log(`  [${issue.disposition}] ${issue.id}: ${issue.reason}${issue.protection ? ` (${issue.protection})` : ''}`);
  for (const blocker of result.blockers) console.log(`  Blocked: ${blocker}. Repair never upgrades a store; any other hippo command does, then run repair again.`);
  const restore = `hippo dormant restore <id>${flags['global'] ? ' --global' : ''}`;
  if (result.backup) console.log(`Backup: ${result.backup}\nMoved ${result.appliedIds.length} memories to dormant storage. Recovery: ${restore}.`);
  else if (apply && result.supported) console.log('Nothing moved: no unprotected memory has a certain defect.');
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  if (!apply) console.log('Preview only. Add --apply to move set-aside memories to dormant storage. Pin a review memory to keep it.');
}

function fixAuditErrors(hippoRoot: string, tenantId: string, result: ReturnType<typeof auditMemories>, flags: CliFlags): void {
  const errors = result.issues.filter(i => i.severity === 'error');
  if (errors.length > 0 && flagIsTrue(flags, 'dry-run')) {
    console.log(`\nWould remove ${errors.length} error-severity memories (dry run, nothing deleted).`);
    console.log(`${result.issues.length - errors.length} warnings would remain (review manually).`);
  } else if (errors.length > 0) {
    const ctx = cliApiContext(hippoRoot, tenantId);
    const removedCount = api.removeAuditErrors(ctx, 'audit --fix', errors).length;
    console.log(`\nRemoved ${removedCount} error-severity memories.`);
    console.log(`${result.issues.length - errors.length} warnings remain (review manually).`);
  } else {
    console.log(`\nNo error-severity issues. Warnings require manual review.`);
  }
}

export async function handleAudit({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  if (args[0] === 'repair') {
    auditRepair(hippoRoot, tenantId, flags);
    return;
  }
  // `audit list` and `audit prune` -> audit-log subcommands.
  // Other forms (no sub, --fix) keep the existing memory-quality auditor
  // for backwards compatibility.
  if (args[0] === 'list' || args[0] === 'prune') {
    await cmdAuditLog(hippoRoot, tenantId, args, flags);
    return;
  }
  requireInit(hippoRoot);
  const entries = loadAllEntries(hippoRoot, tenantId);
  const result = auditMemories(entries, memoriesBackingObjects(hippoRoot));
  const shouldFix = boolFlag(flags, 'fix');

  if (result.issues.length === 0) {
    console.log(`All ${result.total} memories passed quality checks.`);
  } else {
    console.log(`Audited ${result.total} memories: ${result.clean} clean, ${result.issues.length} issues\n`);
    for (const issue of result.issues) {
      const icon = issue.severity === 'error' ? 'ERR' : 'WARN';
      console.log(`  [${icon}] ${issue.memoryId}: ${issue.reason}`);
      console.log(`         "${issue.content.slice(0, 80)}${issue.content.length > 80 ? '...' : ''}"`);
    }
    if (shouldFix) {
      fixAuditErrors(hippoRoot, tenantId, result, flags);
    } else {
      console.log(`\nRun with --fix to auto-remove error-severity issues.`);
    }
  }
}
