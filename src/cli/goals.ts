// `hippo goal`: the per-session goal stack that recall boosts.

import { DEFAULT_TENANT_ID, envHippoSessionId } from '../util/env.js';
import type { PolicyType } from '../store/goals.js';
import * as api from '../api/index.js';
import { cliApiContext } from './api-context.js';
import { printError } from './output.js';
import { type CliFlags, boolFlag, flagIsTrue, isStringFlag, stringFlag, type CommandContext } from './flag-values.js';
import { CliExit } from './exit.js';

// `hippo goal <push|list|complete|suspend|resume>`

const GOAL_POLICY_TYPES: ReadonlyArray<PolicyType> = [
  'schema-fit-biased',
  'error-prioritized',
  'recency-first',
  'hybrid',
];

function isGoalPolicyType(value: string): value is PolicyType {
  return GOAL_POLICY_TYPES.some((type) => type === value);
}

function sanitizeGoalName(s: string): string {
  // Strip C0 control chars + DEL to prevent terminal escape injection.
  return s.replace(/[^\x20-\x7e\u0080-\uffff]/g, '?');
}

function resolveGoalSession(flags: CliFlags, defaultTenantId: string) {
  const sessionId = (
    flags['session-id'] !== undefined
      ? String(flags['session-id'])
      : envHippoSessionId() ?? ''
  ).trim();
  if (!sessionId) {
    printError('session id required (set HIPPO_SESSION_ID or pass --session-id)');
    throw new CliExit(1);
  }
  const tenantId = (
    flags['tenant-id'] !== undefined
      ? String(flags['tenant-id'])
      : defaultTenantId
  ).trim() || DEFAULT_TENANT_ID;
  return { sessionId, tenantId };
}

function readGoalPolicy(flags: CliFlags): { policyType: PolicyType } | undefined {
  const policyRaw = flags['policy'];
  if (policyRaw === true) {
    printError('--policy requires a value (e.g., --policy error-prioritized)');
    throw new CliExit(1);
  }
  if (!isStringFlag(policyRaw)) return undefined;
  if (!isGoalPolicyType(policyRaw)) {
    printError(`Unknown --policy '${policyRaw}'. Expected one of: ${GOAL_POLICY_TYPES.join(' | ')}.`);
    throw new CliExit(1);
  }
  return { policyType: policyRaw };
}

function readGoalLevel(flags: CliFlags): number | undefined {
  const levelRaw = flags['level'];
  if (levelRaw === true) {
    printError('--level requires a value (e.g., --level 1)');
    throw new CliExit(1);
  }
  if (levelRaw === undefined) return undefined;
  const parsed = Number(levelRaw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2 || !Number.isInteger(parsed)) {
    printError('--level must be an integer in [0, 2]');
    throw new CliExit(1);
  }
  return parsed;
}

function cmdGoalPush(hippoRoot: string, defaultTenantId: string, args: string[], flags: CliFlags): void {
  const rawName = args.join(' ').trim();
  if (!rawName) {
    printError('Usage: hippo goal push <name> [--policy <type>] [--success "<condition>"] [--level N] [--parent <goalId>]');
    throw new CliExit(1);
  }
  // Sanitize at WRITE time so corrupt names never enter the DB.
  const name = sanitizeGoalName(rawName);
  if (name !== rawName) {
    printError('note: stripped control characters from goal name');
  }
  const { sessionId, tenantId } = resolveGoalSession(flags, defaultTenantId);

  const policy = readGoalPolicy(flags);

  const successRaw = flags['success'];
  if (successRaw === true) {
    printError('--success requires a value (e.g., --success "<condition>")');
    throw new CliExit(1);
  }
  const successCondition = stringFlag(flags, 'success');

  const level = readGoalLevel(flags);

  const parentRaw = flags['parent'];
  if (parentRaw === true) {
    printError('--parent requires a value (e.g., --parent <goalId>)');
    throw new CliExit(1);
  }
  const parentGoalId = stringFlag(flags, 'parent');

  const goal = api.goalPush(cliApiContext(hippoRoot, tenantId), {
    sessionId,
    goalName: name,
    level,
    parentGoalId,
    successCondition,
    policy,
  });
  console.log(goal.id);
}

function cmdGoalList(hippoRoot: string, defaultTenantId: string, flags: CliFlags): void {
  const { sessionId, tenantId } = resolveGoalSession(flags, defaultTenantId);
  const showAll = boolFlag(flags, 'all');
  const goals = api.goalList(cliApiContext(hippoRoot, tenantId), { sessionId, all: showAll });

  if (goals.length === 0) {
    console.log('(no goals)');
    return;
  }

  // Four columns (id, status, goal_name, outcome); tests only check substrings, so the count is not asserted.
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

function cmdGoalComplete(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal complete <id> [--outcome <0..1>] [--no-propagate]');
    throw new CliExit(1);
  }
  let outcomeScore: number | undefined;
  const outcomeRaw = flags['outcome'];
  if (outcomeRaw === true) {
    printError('--outcome requires a value (e.g., --outcome 0.9)');
    throw new CliExit(1);
  }
  if (outcomeRaw !== undefined) {
    const parsed = Number(outcomeRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      printError('--outcome must be a number in [0, 1]');
      throw new CliExit(1);
    }
    outcomeScore = parsed;
  }
  const noPropagate = flagIsTrue(flags, 'no-propagate');
  api.goalComplete(cliApiContext(hippoRoot, tenantId), id, { outcomeScore, noPropagate });
  console.log('ok');
}

function cmdGoalSuspend(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal suspend <id>');
    throw new CliExit(1);
  }
  api.goalSuspend(cliApiContext(hippoRoot, tenantId), id);
  console.log('ok');
}

function cmdGoalResume(hippoRoot: string, tenantId: string, args: string[]): void {
  const id = args[0];
  if (!id) {
    printError('Usage: hippo goal resume <id>');
    throw new CliExit(1);
  }
  api.goalResume(cliApiContext(hippoRoot, tenantId), id);
  console.log('ok');
}

export function handleGoal({ hippoRoot, tenantId, args, flags }: CommandContext): void {
  const sub = args[0];
  if (!sub) {
    printError('Usage: hippo goal <push|list|complete|suspend|resume> [args]');
    throw new CliExit(1);
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'push':
      cmdGoalPush(hippoRoot, tenantId, subArgs, flags);
      return;
    case 'list':
      cmdGoalList(hippoRoot, tenantId, flags);
      return;
    case 'complete':
      cmdGoalComplete(hippoRoot, tenantId, subArgs, flags);
      return;
    case 'suspend':
      cmdGoalSuspend(hippoRoot, tenantId, subArgs);
      return;
    case 'resume':
      cmdGoalResume(hippoRoot, tenantId, subArgs);
      return;
    default:
      printError(`Unknown goal subcommand: ${sub}. Expected: push | list | complete | suspend | resume.`);
      throw new CliExit(1);
  }
}
