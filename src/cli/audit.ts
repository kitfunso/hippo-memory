// `hippo audit`: list and prune the audit log.

import { loadAllEntries } from '../store/entry-reads.js';
import { deleteEntry, memoriesBackingObjects } from '../store/delete-and-batch.js';
import { openHippoDb, closeHippoDb } from '../db.js';
import { auditMemories, AUDIT_OPS, type AuditEvent, type AuditOp } from '../audit.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { pruneAuditLog, parseOlderThanFlag } from '../audit-prune.js';
import { printError } from './output.js';
import { requireInit, type CommandContext, resolveAuthRoot } from './shared.js';
import { repairAutomaticMemories } from '../quality-repair.js';
import { getGlobalRoot } from '../shared.js';

// ---------------------------------------------------------------------------
// Audit log subcommands (`hippo audit list`)
// ---------------------------------------------------------------------------

const VALID_AUDIT_OPS: ReadonlySet<AuditOp> = new Set<AuditOp>(AUDIT_OPS);

function formatAuditRow(ev: AuditEvent): string {
  const target = ev.targetId ?? '-';
  const meta = JSON.stringify(ev.metadata ?? {});
  return `${ev.ts}  ${ev.actor}  ${ev.op}  ${target}  ${meta}`;
}

function cmdAuditList(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const root = resolveAuthRoot(hippoRoot, flags);
  const asJson = Boolean(flags['json']);
  const tenantId = resolveTenantId({});

  const opFlag = typeof flags['op'] === 'string' ? (flags['op'] as string) : undefined;
  if (opFlag && !VALID_AUDIT_OPS.has(opFlag as AuditOp)) {
    // Built from the Set so the message cannot drift from the valid ops.
    const expected = Array.from(VALID_AUDIT_OPS).join(' | ');
    printError(`Unknown --op value: ${opFlag}. Expected one of: ${expected}.`);
    process.exit(1);
  }
  const op = opFlag as AuditOp | undefined;

  const since = typeof flags['since'] === 'string' ? (flags['since'] as string) : undefined;
  if (since !== undefined && !Number.isFinite(new Date(since).getTime())) {
    printError(`Invalid --since: ${since} (expected an ISO timestamp like 2026-04-22 or 2026-04-22T12:00:00Z).`);
    process.exit(1);
  }

  const limitRaw = flags['limit'];
  let limit = 100;
  if (limitRaw !== undefined && typeof limitRaw !== 'boolean') {
    const parsed = parseInt(String(limitRaw), 10);
    if (!Number.isFinite(parsed)) {
      printError(`Invalid --limit value: ${String(limitRaw)} (expected a positive integer).`);
      process.exit(1);
    }
    limit = parsed;
  }
  if (limit < 1 || limit > 10000) {
    printError(`--limit must be between 1 and 10000 (got ${limit}).`);
    process.exit(1);
  }

  const ctx: api.Context = { hippoRoot: root, tenantId, actor: { subject: 'cli', role: 'admin' } };
  const events = api.auditList(ctx, { op, since, limit });

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

function cmdAuditPrune(hippoRoot: string, flags: Record<string, string | boolean | string[]>): void {
  const olderThanRaw = typeof flags['older-than'] === 'string' ? (flags['older-than'] as string) : '';
  if (!olderThanRaw) {
    printError('Usage: hippo audit prune --older-than <Nd> [--dry-run] [--tenant <t>]');
    process.exit(1);
  }
  let olderThanDays: number;
  try {
    olderThanDays = parseOlderThanFlag(olderThanRaw);
  } catch (e) {
    printError((e as Error).message);
    process.exit(1);
  }
  const tenantId = typeof flags['tenant'] === 'string'
    ? (flags['tenant'] as string).trim() || resolveTenantId({})
    : resolveTenantId({});
  const dryRun = flags['dry-run'] === true;
  const asJson = Boolean(flags['json']);

  const db = openHippoDb(hippoRoot);
  let result;
  try {
    result = pruneAuditLog(db, { olderThanDays, tenantId, dryRun, actor: 'cli' });
  } finally {
    closeHippoDb(db);
  }

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

function cmdAuditLog(hippoRoot: string, args: string[], flags: Record<string, string | boolean | string[]>): void {
  const sub = args[0];
  if (sub === 'list') {
    cmdAuditList(hippoRoot, flags);
    return;
  }
  if (sub === 'prune') {
    cmdAuditPrune(hippoRoot, flags);
    return;
  }
  printError(`Unknown audit subcommand: ${sub}. Expected: list | prune.`);
  process.exit(1);
}

export function handleAudit({ hippoRoot, args, flags }: CommandContext): void {
  if (args[0] === 'repair') {
    const apply = flags['apply'] === true && flags['dry-run'] !== true;
    const result = repairAutomaticMemories(flags['global'] ? getGlobalRoot() : hippoRoot, { tenantId: resolveTenantId({}), apply });
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
    return;
  }
  // `audit list` and `audit prune` -> audit-log subcommands.
  // Other forms (no sub, --fix) keep the existing memory-quality auditor
  // for backwards compatibility.
  if (args[0] === 'list' || args[0] === 'prune') {
    cmdAuditLog(hippoRoot, args, flags);
    return;
  }
  requireInit(hippoRoot);
  const entries = loadAllEntries(hippoRoot, resolveTenantId({}));
  const result = auditMemories(entries, memoriesBackingObjects(hippoRoot));
  const shouldFix = Boolean(flags['fix']);

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
      const errors = result.issues.filter(i => i.severity === 'error');
      if (errors.length > 0 && flags['dry-run'] === true) {
        console.log(`\nWould remove ${errors.length} error-severity memories (dry run, nothing deleted).`);
        console.log(`${result.issues.length - errors.length} warnings would remain (review manually).`);
      } else if (errors.length > 0) {
        const removedCount = errors.filter((issue) =>
          deleteEntry(hippoRoot, issue.memoryId, { reason: `audit --fix: ${issue.reason}`, automatic: true })).length;
        console.log(`\nRemoved ${removedCount} error-severity memories.`);
        console.log(`${result.issues.length - errors.length} warnings remain (review manually).`);
      } else {
        console.log(`\nNo error-severity issues. Warnings require manual review.`);
      }
    } else {
      console.log(`\nRun with --fix to auto-remove error-severity issues.`);
    }
  }
}
