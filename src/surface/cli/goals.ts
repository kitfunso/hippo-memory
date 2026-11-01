// `hippo goal`: the per-session goal stack that recall boosts.

import { envHippoSessionId } from '../../base/util/env.js';
import { DEFAULT_TENANT_ID } from '../../base/util/tenant.js';
import * as api from '../../api/index.js';
import { printError } from './output.js';
import { sanitizeLogMessage } from '../capture/compact.js';
import { type CliFlags, type CommandContext, boolFlag, stringFlagOrExit } from './flag-values.js';
import { fail } from './exit.js';
import type { PolicyType } from '../../base/ports/store/types.js';

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

function resolveGoalSession(flags: CliFlags, defaultTenantId: string) {
  const sessionId = (stringFlagOrExit(flags, 'session-id') ?? envHippoSessionId() ?? '').trim();
  if (!sessionId) {
    fail('session id required (set HIPPO_SESSION_ID or pass --session-id)');
  }
  const tenantId =
    (stringFlagOrExit(flags, 'tenant-id') ?? defaultTenantId).trim() || DEFAULT_TENANT_ID;
  return { sessionId, tenantId };
}

function readGoalPolicy(flags: CliFlags): { policyType: PolicyType } | undefined {
  const policyRaw = stringFlagOrExit(flags, 'policy');
  if (policyRaw === undefined) return undefined;
  if (!isGoalPolicyType(policyRaw)) {
    fail(`Unknown --policy '${policyRaw}'. Expected one of: ${GOAL_POLICY_TYPES.join(' | ')}.`);
  }
  return { policyType: policyRaw };
}

function readGoalLevel(flags: CliFlags): number | undefined {
  const levelRaw = stringFlagOrExit(flags, 'level');
  if (levelRaw === undefined) return undefined;
  const parsed = Number(levelRaw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2 || !Number.isInteger(parsed)) {
    fail('--level must be an integer in [0, 2]');
  }
  return parsed;
}

async function pushGoal({
  cli,
  hippoRoot,
  tenantId: defaultTenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const rawName = args.join(' ').trim();
  // Sanitize at WRITE time so corrupt names never enter the DB, and before the empty check so a
  // name of control characters alone is no name.
  const name = sanitizeLogMessage(rawName).trim();
  if (!name) {
    fail(
      'Usage: hippo goal push <name> [--policy <type>] [--success "<condition>"] [--level N] [--parent <goalId>]',
    );
  }
  if (name !== rawName) {
    printError('note: stripped control characters from goal name');
  }
  const { sessionId, tenantId } = resolveGoalSession(flags, defaultTenantId);

  const policy = readGoalPolicy(flags);

  const successCondition = stringFlagOrExit(flags, 'success');
  const level = readGoalLevel(flags);
  const parentGoalId = stringFlagOrExit(flags, 'parent');

  const goal = await api.goalPush(cli.apiContext(hippoRoot, tenantId), {
    sessionId,
    goalName: name,
    level,
    parentGoalId,
    successCondition,
    policy,
  });
  console.log(goal.id);
}

async function listGoals({
  cli,
  hippoRoot,
  tenantId: defaultTenantId,
  flags,
}: CommandContext): Promise<void> {
  const { sessionId, tenantId } = resolveGoalSession(flags, defaultTenantId);
  const showAll = boolFlag(flags, 'all');
  const goals = await api.goalList(cli.apiContext(hippoRoot, tenantId), {
    sessionId,
    all: showAll,
  });

  if (goals.length === 0) {
    console.log('(no goals)');
    return;
  }

  // Four columns (id, status, goal_name, outcome); tests only check substrings, so the count is
  // not asserted.
  const rows = goals.map((g) => ({
    id: g.id,
    status: g.status,
    name: sanitizeLogMessage(g.goalName),
    outcome: g.outcomeScore !== undefined ? g.outcomeScore.toString() : '-',
  }));
  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    name: Math.max(4, ...rows.map((r) => r.name.length)),
    outcome: Math.max(7, ...rows.map((r) => r.outcome.length)),
  };
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  console.log(
    `${pad('id', widths.id)}  ${pad('status', widths.status)}  ${pad('name', widths.name)}  ` +
      pad('outcome', widths.outcome),
  );
  for (const r of rows) {
    console.log(
      `${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(r.name, widths.name)}  ` +
        pad(r.outcome, widths.outcome),
    );
  }
}

async function completeGoal({
  cli,
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    fail('Usage: hippo goal complete <id> [--outcome <0..1>] [--no-propagate]');
  }
  let outcomeScore: number | undefined;
  const outcomeRaw = stringFlagOrExit(flags, 'outcome');
  if (outcomeRaw !== undefined) {
    const parsed = Number(outcomeRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      fail('--outcome must be a number in [0, 1]');
    }
    outcomeScore = parsed;
  }
  const noPropagate = boolFlag(flags, 'no-propagate');
  await api.goalComplete(cli.apiContext(hippoRoot, tenantId), id, { outcomeScore, noPropagate });
  console.log('ok');
}

async function suspendGoal({ cli, hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    fail('Usage: hippo goal suspend <id>');
  }
  await api.goalSuspend(cli.apiContext(hippoRoot, tenantId), id);
  console.log('ok');
}

async function resumeGoal({ cli, hippoRoot, tenantId, args }: CommandContext): Promise<void> {
  const id = args[0];
  if (!id) {
    fail('Usage: hippo goal resume <id>');
  }
  await api.goalResume(cli.apiContext(hippoRoot, tenantId), id);
  console.log('ok');
}

export async function handleGoal(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  const sub = args[0];
  if (!sub) {
    fail('Usage: hippo goal <push|list|complete|suspend|resume> [args]');
  }
  const subArgs = args.slice(1);
  switch (sub) {
    case 'push':
      await pushGoal({ cli, hippoRoot, tenantId, args: subArgs, flags });
      return;
    case 'list':
      await listGoals(cmd);
      return;
    case 'complete':
      await completeGoal({ cli, hippoRoot, tenantId, args: subArgs, flags });
      return;
    case 'suspend':
      await suspendGoal({ cli, hippoRoot, tenantId, args: subArgs, flags });
      return;
    case 'resume':
      await resumeGoal({ cli, hippoRoot, tenantId, args: subArgs, flags });
      return;
    default:
      fail(`Unknown goal subcommand: ${sub}. Expected: push | list | complete | suspend | resume.`);
  }
}
