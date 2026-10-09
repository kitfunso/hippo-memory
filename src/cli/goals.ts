// `hippo goal`: the per-session goal stack that recall boosts.

import { envHippoSessionId } from '../env.js';
import type { PolicyType } from '../goals.js';
import * as api from '../api.js';
import { resolveTenantId } from '../tenant.js';
import { printError } from './output.js';
import { type CliFlags, boolFlag, flagIsTrue } from './shared.js';

// ---------------------------------------------------------------------------
// `hippo goal <push|list|complete|suspend|resume>`
// ---------------------------------------------------------------------------

const GOAL_POLICY_TYPES: ReadonlyArray<PolicyType> = [
  'schema-fit-biased',
  'error-prioritized',
  'recency-first',
  'hybrid',
];

function sanitizeGoalName(s: string): string {
  // Strip C0 control chars + DEL to prevent terminal escape injection.
  return s.replace(/[\x00-\x1f\x7f]/g, '?');
}

function resolveGoalSession(flags: CliFlags): { sessionId: string; tenantId: string } {
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : envHippoSessionId() ?? ''
  ).trim();
  if (!sessionId) {
    printError('session id required (set HIPPO_SESSION_ID or pass --session-id)');
    process.exit(1);
  }
  const tenantId = (
    flags['tenant-id'] !== undefined
      ? String(flags['tenant-id'])
      : resolveTenantId({})
  ).trim() || 'default';
  return { sessionId, tenantId };
}

function readGoalPolicy(flags: CliFlags): { policyType: PolicyType } | undefined {
  const policyRaw = flags['policy'];
  if (policyRaw === true) {
    printError('--policy requires a value (e.g., --policy error-prioritized)');
    process.exit(1);
  }
  if (typeof policyRaw !== 'string') return undefined;
  if (!(GOAL_POLICY_TYPES as readonly string[]).includes(policyRaw)) {
    printError(`Unknown --policy '${policyRaw}'. Expected one of: ${GOAL_POLICY_TYPES.join(' | ')}.`);
    process.exit(1);
  }
  return { policyType: policyRaw as PolicyType };
}

function readGoalLevel(flags: CliFlags): number | undefined {
  const levelRaw = flags['level'];
  if (levelRaw === true) {
    printError('--level requires a value (e.g., --level 1)');
    process.exit(1);
  }
  if (levelRaw === undefined) return undefined;
  const parsed = Number(levelRaw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2 || !Number.isInteger(parsed)) {
    printError('--level must be an integer in [0, 2]');
    process.exit(1);
  }
  return parsed;
}

function cmdGoalPush(hippoRoot: string, args: string[], flags: CliFlags): void {
  const rawName = args.join(' ').trim();
  if (!rawName) {
    printError('Usage: hippo goal push <name> [--policy <type>] [--success "<condition>"] [--level N] [--parent <goalId>]');
    process.exit(1);
  }
  // Sanitize at WRITE time so corrupt names never enter the DB.
  const name = sanitizeGoalName(rawName);
  if (name !== rawName) {
    printError('note: stripped control characters from goal name');
  }
  const { sessionId, tenantId } = resolveGoalSession(flags);

  const policy = readGoalPolicy(flags);

  const successRaw = flags['success'];
  if (successRaw === true) {
    printError('--success requires a value (e.g., --success "<condition>")');
    process.exit(1);
  }
  const successCondition = typeof successRaw === 'string' ? successRaw : undefined;

  const level = readGoalLevel(flags);

  const parentRaw = flags['parent'];
  if (parentRaw === true) {
    printError('--parent requires a value (e.g., --parent <goalId>)');
    process.exit(1);
  }
  const parentGoalId = typeof parentRaw === 'string' ? parentRaw : undefined;

  const goal = api.goalPush(goalContext(hippoRoot, tenantId), {
    sessionId,
    goalName: name,
    level,
    parentGoalId,
    successCondition,
    policy,
  });
  console.log(goal.id);
}

function goalContext(hippoRoot: string, tenantId: string = resolveTenantId({})): api.Context {
  return { hippoRoot, tenantId, actor: api.adminActor('cli') };
}

function cmdGoalList(hippoRoot: string, flags: CliFlags): void {
  const { sessionId, tenantId } = resolveGoalSession(flags);
  const showAll = boolFlag(flags, 'all');
  const goals = api.goalList(goalContext(hippoRoot, tenantId), { sessionId, all: showAll });

  if (goals.length === 0) {
    console.log('(no goals)');
    return;
  }

  // 4-column table: id, status, goal_name, outcome. Plan calls it a "2-column"
  // table but the assertion list (id, status, goal_name, outcome) needs four;
  // tests check for substrings ('active', '0.9', name) so column count is
  // observably four but not asserted.
  const rows = goals.map(g => ({
    id: g.id,
    status: g.status,
    name: sanitizeGoalName(g.goalName),
    outcome: g.outcomeScore !== undefined ? g.outcomeScore.toString() : '-',
  }));
  const widths = {
    id: Math.max(2, ...rows.map(r => r.id.length)),
    status: Math.max(6, ...rows.map(r => r.status.length)),
    name: Math.max(4, ...rows.map(r => r.name.length)),
    outcome: Math.max(7, ...rows.map(r => r.outcome.length)),
  };
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(`${pad('id', widths.id)}  ${pad('status', widths.status)}  ${pad('name', widths.name)}  ${pad('outcome', widths.outcome)}`);
  for (const r of rows) {
    console.log(`${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(r.name, widths.name)}  ${pad(r.outcome, widths.outcome)}`);
  }
}

function cmdGoalComplete(hippoRoot: string, args: string[], flags: CliFlags): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal complete <id> [--outcome <0..1>] [--no-propagate]');
    process.exit(1);
  }
  let outcomeScore: number | undefined;
  const outcomeRaw = flags['outcome'];
  if (outcomeRaw === true) {
    printError('--outcome requires a value (e.g., --outcome 0.9)');
    process.exit(1);
  }
  if (outcomeRaw !== undefined) {
    const parsed = Number(outcomeRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      printError('--outcome must be a number in [0, 1]');
      process.exit(1);
    }
    outcomeScore = parsed;
  }
  const noPropagate = flagIsTrue(flags, 'no-propagate');
  api.goalComplete(goalContext(hippoRoot), id, { outcomeScore, noPropagate });
  console.log('ok');
}

function cmdGoalSuspend(hippoRoot: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal suspend <id>');
    process.exit(1);
  }
  api.goalSuspend(goalContext(hippoRoot), id);
  console.log('ok');
}

function cmdGoalResume(hippoRoot: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal resume <id>');
    process.exit(1);
  }
  api.goalResume(goalContext(hippoRoot), id);
  console.log('ok');
}

export function cmdGoal(hippoRoot: string, args: string[], flags: CliFlags): void {
  const sub = args[0];
  if (!sub) {
    printError('Usage: hippo goal <push|list|complete|suspend|resume> [args]');
    process.exit(1);
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'push':
      cmdGoalPush(hippoRoot, subArgs, flags);
      return;
    case 'list':
      cmdGoalList(hippoRoot, flags);
      return;
    case 'complete':
      cmdGoalComplete(hippoRoot, subArgs, flags);
      return;
    case 'suspend':
      cmdGoalSuspend(hippoRoot, subArgs);
      return;
    case 'resume':
      cmdGoalResume(hippoRoot, subArgs);
      return;
    default:
      printError(`Unknown goal subcommand: ${sub}. Expected: push | list | complete | suspend | resume.`);
      process.exit(1);
  }
}
