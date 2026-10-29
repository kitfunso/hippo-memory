// `hippo handoff`: write and read the note one session leaves for the next.

import {
  isHandoffOutcome,
  formatHandoffEvidenceLine,
  type HandoffOutcome,
  type SessionHandoff,
} from '../../base/session/handoff.js';
import { collectHandoffEvidence } from '../capture/handoff-evidence.js';
import { requireInit } from './shared.js';
import { printHandoff } from './print.js';
import {
  type CliFlags,
  boolFlag,
  parsePositiveId,
  repeatedFlag,
  stringFlagOrExit,
  type CommandContext,
  hasFlag,
  stringFlag,
} from './flag-values.js';
import { fail } from './exit.js';

const HANDOFF_CREATE_USAGE =
  'Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] [--task <id>] [--artifact <path>...] ' +
  '[--constraint <text>...] [--outcome <success|failure|partial>] [--target-runtime <name>] [--card-id <id>] ' +
  '[--tests <pass|fail|unknown>]';

async function handoffCreate({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const summary = stringFlagOrExit(flags, 'summary') ?? '';
  if (!summary) {
    fail(HANDOFF_CREATE_USAGE);
  }

  const handoff = handoffFromFlags(flags, summary, handoffOutcomeFlag(flags));
  printCreatedHandoff(
    await cli.store(hippoRoot).sessions.save(tenantId, 'handoff', { handoff }, null),
  );
}

function handoffOutcomeFlag(flags: CliFlags): HandoffOutcome | undefined {
  const outcomeRaw = stringFlag(flags, 'outcome');
  if (hasFlag(flags, 'outcome') && !isHandoffOutcome(outcomeRaw)) {
    // A bare --outcome parses as true, and the message has always echoed it.
    fail(`Invalid outcome: "${outcomeRaw ?? 'true'}". Must be one of: success, failure, partial.`);
  }
  // SAFETY: isHandoffOutcome above already refused any non-matching value.
  return outcomeRaw as HandoffOutcome | undefined;
}

function handoffFromFlags(
  flags: CliFlags,
  summary: string,
  outcome: HandoffOutcome | undefined,
): Omit<SessionHandoff, 'updatedAt'> {
  const sessionId =
    (stringFlagOrExit(flags, 'session') ?? stringFlagOrExit(flags, 'id') ?? '') ||
    `fallback-${Date.now()}-${process.pid}`;
  const nextAction = stringFlagOrExit(flags, 'next') || undefined;
  const taskId = stringFlagOrExit(flags, 'task') || undefined;
  const artifacts = repeatedFlag(flags, 'artifact');
  const constraints = repeatedFlag(flags, 'constraint');
  const targetRuntime = stringFlagOrExit(flags, 'target-runtime') || undefined;
  const cardId = stringFlagOrExit(flags, 'card-id') || undefined;
  const testStatus = stringFlagOrExit(flags, 'tests') ?? '';
  const evidence = collectHandoffEvidence(
    process.cwd(),
    testStatus === 'pass' || testStatus === 'fail' ? testStatus : 'unknown',
  );

  return {
    version: 1,
    sessionId,
    repoRoot: process.cwd(),
    taskId,
    summary,
    nextAction,
    artifacts,
    constraints,
    evidence,
    outcome,
    targetRuntime,
    cardId,
  };
}

function printCreatedHandoff(handoff: SessionHandoff): void {
  console.log(`Created session handoff for session ${handoff.sessionId}`);
  console.log(`   Summary: ${handoff.summary}`);
  if (handoff.nextAction) console.log(`   Next: ${handoff.nextAction}`);
  if (handoff.artifacts && handoff.artifacts.length > 0) {
    console.log(`   Artifacts: ${handoff.artifacts.join(', ')}`);
  }
  if (handoff.constraints && handoff.constraints.length > 0) {
    console.log(`   Constraints: ${handoff.constraints.join(', ')}`);
  }
  if (handoff.outcome) console.log(`   Outcome: ${handoff.outcome}`);
  if (handoff.targetRuntime) console.log(`   Target runtime: ${handoff.targetRuntime}`);
  if (handoff.cardId) console.log(`   Card: ${handoff.cardId}`);
  if (handoff.evidence) console.log(`   Evidence: ${formatHandoffEvidenceLine(handoff.evidence)}`);
}

async function handoffLatest({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const sessionId =
    (stringFlagOrExit(flags, 'session') ?? stringFlagOrExit(flags, 'id') ?? '') || undefined;
  const query = { sessionId: sessionId ?? null };
  const handoff = await cli.store(hippoRoot).sessions.read(tenantId, 'handoff', query, null);

  if (!handoff) {
    if (boolFlag(flags, 'json')) {
      console.log(JSON.stringify({ handoff: null }));
    } else {
      console.log('No session handoff found.');
    }
    return;
  }

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ handoff }, null, 2));
    return;
  }

  printHandoff(handoff);
}

async function handoffShow({
  cli,
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  const idArg = args[1];
  if (!idArg) {
    fail('Usage: hippo handoff show <id> [--json]');
  }

  const handoffId = parsePositiveId(idArg, 'handoff');

  const handoff = await cli.store(hippoRoot).sessions.read(tenantId, 'handoff', { id: handoffId });

  if (!handoff) {
    if (boolFlag(flags, 'json')) {
      console.log(JSON.stringify({ handoff: null }));
    } else {
      console.log(`No handoff found with ID ${handoffId}.`);
    }
    return;
  }

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ handoff }, null, 2));
    return;
  }

  printHandoff(handoff);
}

export async function handleHandoff(cmd: CommandContext): Promise<void> {
  const { hippoRoot, args } = cmd;
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'latest';
  if (subcommand === 'create') return handoffCreate(cmd);
  if (subcommand === 'latest') return handoffLatest(cmd);
  if (subcommand === 'show') return handoffShow(cmd);

  fail('Usage: hippo handoff <create|latest|show>');
}
