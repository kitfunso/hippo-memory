// Where-you-left-off verbs: snapshot, session, handoff, current and working memory.

import {
  snapshotSave as apiSnapshotSave,
  snapshotClear as apiSnapshotClear,
  snapshotLoad,
  sessionEventAppend,
  sessionEventList,
  continuityLatest,
  handoffStampOutcome,
  handoffSave,
  handoffLatest as apiHandoffLatest,
  handoffById,
  workingMemoryPush,
  workingMemoryRead,
  workingMemoryClear,
  workingMemoryFlush,
} from '../api/continuity.js';
import { cliApiContext } from './api-context.js';
import { isHandoffOutcome, formatHandoffEvidenceLine, type HandoffOutcome } from '../core/handoff.js';
import { collectHandoffEvidence } from '../capture/handoff-evidence.js';
import type { SessionEvent, TaskSnapshot } from '../store/rows.js';
import { requireInit } from './shared.js';
import { printActiveTaskSnapshot, printSessionEvents, printHandoff } from './print.js';
import {
  type CliFlags,
  boolFlag,
  isStringFlag,
  numberFlag,
  stringFlagOrExit,
  type CommandContext,
} from './flag-values.js';
import { fail } from './exit.js';

const ISO_DATETIME_CHARS = 19;

async function snapshotSave(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const task = stringFlagOrExit(flags, 'task') ?? '';
  const summary = stringFlagOrExit(flags, 'summary') ?? '';
  const nextStep = stringFlagOrExit(flags, 'next-step') ?? '';
  const sessionId = stringFlagOrExit(flags, 'session') ?? stringFlagOrExit(flags, 'id') ?? '';

  if (!task || !summary || !nextStep) {
    fail(
      'Usage: hippo snapshot save --task <task> --summary <summary> --next-step <step> ' +
        '[--source <source>] [--session <session-id>]',
    );
  }

  const snapshot = await apiSnapshotSave(cliApiContext(hippoRoot, tenantId), {
    task,
    summary,
    next_step: nextStep,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
    session_id: sessionId || null,
  });

  console.log(`Saved active task snapshot #${snapshot.id}`);
  console.log(`   Task: ${snapshot.task}`);
  console.log(`   Next: ${snapshot.next_step}`);
  if (snapshot.session_id) {
    console.log(`   Session: ${snapshot.session_id}`);
  }
}

async function snapshotClear(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const status = stringFlagOrExit(flags, 'status') ?? 'cleared';
  const cleared = await apiSnapshotClear(cliApiContext(hippoRoot, tenantId), status);
  if (!cleared) {
    console.log('No active task snapshot to clear.');
    return;
  }
  console.log('Cleared active task snapshot.');
}

async function snapshotShow(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const snapshot = await snapshotLoad(cliApiContext(hippoRoot, tenantId));
  if (!snapshot) {
    if (flags['json']) {
      console.log(JSON.stringify({ snapshot: null }));
    } else {
      console.log('No active task snapshot saved.');
    }
    return;
  }

  if (flags['json']) {
    console.log(JSON.stringify({ snapshot }, null, 2));
    return;
  }

  printActiveTaskSnapshot(snapshot);
}

export async function handleSnapshot({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'save') return snapshotSave(hippoRoot, tenantId, flags);
  if (subcommand === 'clear') return snapshotClear(hippoRoot, tenantId, flags);
  if (subcommand === 'show') return snapshotShow(hippoRoot, tenantId, flags);

  fail('Usage: hippo snapshot <save|show|clear>');
}


/** The flags every `hippo session` subcommand reads up front. */
interface SessionArgs {
  readonly sessionId: string;
  readonly task: string;
  readonly limit: number;
}

async function sessionLog(hippoRoot: string, tenantId: string, s: SessionArgs, flags: CliFlags): Promise<void> {
  const eventType = stringFlagOrExit(flags, 'type') ?? 'note';
  const content = stringFlagOrExit(flags, 'content') ?? '';

  if (!s.sessionId || !content) {
    fail(
      'Usage: hippo session log --id <session-id> --content <text> [--type <type>] [--task <task>] ' +
        '[--source <source>]',
    );
  }

  const event = await sessionEventAppend(cliApiContext(hippoRoot, tenantId), {
    session_id: s.sessionId,
    task: s.task || null,
    event_type: eventType || 'note',
    content,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
  });

  console.log(`Logged session event #${event.id}`);
  console.log(`   Session: ${event.session_id}`);
  console.log(`   Type: ${event.event_type}`);
}

async function sessionShow(hippoRoot: string, tenantId: string, s: SessionArgs, flags: CliFlags): Promise<void> {
  const events = await sessionEventList(cliApiContext(hippoRoot, tenantId), {
    sessionId: s.sessionId || undefined,
    task: s.task || undefined,
    limit: s.limit,
  });

  if (flags['json']) {
    console.log(JSON.stringify({ events }, null, 2));
    return;
  }

  printSessionEvents(events);
}

async function sessionLatest(hippoRoot: string, tenantId: string, s: SessionArgs, flags: CliFlags): Promise<void> {
  const { snapshot, events } = await continuityLatest(cliApiContext(hippoRoot, tenantId), {
    sessionId: s.sessionId,
    limit: s.limit,
  });

  if (flags['json']) {
    console.log(JSON.stringify({ snapshot: snapshot ?? null, events }, null, 2));
    return;
  }

  if (snapshot) {
    printActiveTaskSnapshot(snapshot);
  } else {
    console.log('No active task snapshot.');
    console.log('');
  }
  printSessionEvents(events);
}

type SessionCompleteMetadata = {
  ended_at: string;
  summary?: string;
};

async function sessionComplete(hippoRoot: string, tenantId: string, s: SessionArgs, flags: CliFlags): Promise<void> {
  const { sessionId, task } = s;
  const outcomeRaw = stringFlagOrExit(flags, 'outcome') ?? '';
  const summary = stringFlagOrExit(flags, 'summary') ?? '';

  if (!sessionId) {
    fail('Usage: hippo session complete --session <session-id> --outcome <success|failure|partial> [--summary "..."]');
  }
  if (!isHandoffOutcome(outcomeRaw)) {
    fail(`Invalid outcome: "${outcomeRaw}". Must be one of: success, failure, partial.`);
  }
  const outcome: HandoffOutcome = outcomeRaw;

  const metadata: SessionCompleteMetadata = { ended_at: new Date().toISOString() };
  if (summary) metadata.summary = summary;

  const event = await sessionEventAppend(cliApiContext(hippoRoot, tenantId), {
    session_id: sessionId,
    task: task || null,
    event_type: 'session_complete',
    content: outcome,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
    metadata,
  });

  console.log(`Completed session ${event.session_id} with outcome=${outcome} (event #${event.id})`);

  const stamped = await handoffStampOutcome(cliApiContext(hippoRoot, tenantId), sessionId, outcome);
  if (stamped > 0) {
    console.log(`Stamped outcome on handoff for session ${sessionId}`);
  }
}

export async function handleSession({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';
  const sessionId = stringFlagOrExit(flags, 'id') ?? stringFlagOrExit(flags, 'session') ?? '';
  const task = stringFlagOrExit(flags, 'task') ?? '';
  const limit = Math.max(1, numberFlag(flags, 'limit') || 8);
  const s: SessionArgs = { sessionId, task, limit };

  if (subcommand === 'log') return sessionLog(hippoRoot, tenantId, s, flags);
  if (subcommand === 'show') return sessionShow(hippoRoot, tenantId, s, flags);
  if (subcommand === 'latest') return sessionLatest(hippoRoot, tenantId, s, flags);
  if (subcommand === 'complete') return sessionComplete(hippoRoot, tenantId, s, flags);
  if (subcommand === 'resume') return sessionResume(hippoRoot, tenantId, sessionId);

  fail('Usage: hippo session <log|show|latest|resume|complete>');
}

async function sessionResume(hippoRoot: string, tenantId: string, sessionId: string): Promise<void> {
  const handoff = await apiHandoffLatest(cliApiContext(hippoRoot, tenantId), sessionId || undefined);
  if (!handoff) {
    console.log('No handoff to resume from.');
    return;
  }

  const lines: string[] = [
    '## Session Handoff (resumed)',
    '',
    `- Session: ${handoff.sessionId}`,
    `- Updated: ${handoff.updatedAt}`,
  ];
  if (handoff.taskId) lines.push(`- Task: ${handoff.taskId}`);
  if (handoff.repoRoot) lines.push(`- Repo: ${handoff.repoRoot}`);
  if (handoff.outcome) lines.push(`- Outcome: ${handoff.outcome}`);
  if (handoff.targetRuntime) lines.push(`- Target runtime: ${handoff.targetRuntime}`);
  if (handoff.cardId) lines.push(`- Card: ${handoff.cardId}`);
  lines.push('', '### Summary', handoff.summary);
  if (handoff.nextAction) {
    lines.push('', '### Next action', handoff.nextAction);
  }
  if (handoff.artifacts && handoff.artifacts.length > 0) {
    lines.push('', '### Artifacts');
    for (const artifact of handoff.artifacts) {
      lines.push(`- ${artifact}`);
    }
  }
  if (handoff.constraints && handoff.constraints.length > 0) {
    lines.push('', '### Constraints');
    for (const constraint of handoff.constraints) {
      lines.push(`- ${constraint}`);
    }
  }
  if (handoff.evidence) {
    lines.push('', '### Evidence', formatHandoffEvidenceLine(handoff.evidence));
  }
  lines.push('');
  console.log(lines.join('\n'));
}

/** A repeatable flag as a list: absent is empty, one value is a singleton. */
function flagList(value: string | boolean | string[] | undefined): string[] {
  return Array.isArray(value) ? value : (isStringFlag(value) ? [value] : []);
}

const HANDOFF_CREATE_USAGE = 'Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] ' +
  '[--task <id>] [--artifact <path>...] ' +
  '[--constraint <text>...] [--outcome <success|failure|partial>] [--target-runtime <name>] [--card-id <id>] ' +
  '[--tests <pass|fail|unknown>]';

async function handoffCreate(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const summary = stringFlagOrExit(flags, 'summary') ?? '';
  if (!summary) {
    fail(HANDOFF_CREATE_USAGE);
  }

  const outcomeRaw = flags['outcome'];
  if (outcomeRaw !== undefined && !isHandoffOutcome(outcomeRaw)) {
    fail(`Invalid outcome: "${String(outcomeRaw)}". Must be one of: success, failure, partial.`);
  }

  const sessionId = (stringFlagOrExit(flags, 'session') ?? stringFlagOrExit(flags, 'id') ?? '') ||
    `fallback-${Date.now()}-${process.pid}`;
  const nextAction = stringFlagOrExit(flags, 'next') || undefined;
  const taskId = stringFlagOrExit(flags, 'task') || undefined;
  const artifacts = flagList(flags['artifact']);
  const constraints = flagList(flags['constraint']);
  const targetRuntime = stringFlagOrExit(flags, 'target-runtime') || undefined;
  const cardId = stringFlagOrExit(flags, 'card-id') || undefined;
  const testStatus = stringFlagOrExit(flags, 'tests') ?? '';
  const evidence = collectHandoffEvidence(
    process.cwd(),
    testStatus === 'pass' || testStatus === 'fail' ? testStatus : 'unknown',
  );

  const handoff = await handoffSave(cliApiContext(hippoRoot, tenantId), {
    version: 1,
    sessionId,
    repoRoot: process.cwd(),
    taskId,
    summary,
    nextAction,
    artifacts,
    constraints,
    evidence,
    // SAFETY: isHandoffOutcome above already refused any non-matching value.
    outcome: outcomeRaw as HandoffOutcome | undefined,
    targetRuntime,
    cardId,
  });
  printCreatedHandoff(handoff);
}

function printCreatedHandoff(handoff: Awaited<ReturnType<typeof handoffSave>>): void {
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

async function handoffLatest(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const sessionId = (stringFlagOrExit(flags, 'session') ?? stringFlagOrExit(flags, 'id') ?? '') || undefined;
  const handoff = await apiHandoffLatest(cliApiContext(hippoRoot, tenantId), sessionId);

  if (!handoff) {
    if (flags['json']) {
      console.log(JSON.stringify({ handoff: null }));
    } else {
      console.log('No session handoff found.');
    }
    return;
  }

  if (flags['json']) {
    console.log(JSON.stringify({ handoff }, null, 2));
    return;
  }

  printHandoff(handoff);
}

async function handoffShow(hippoRoot: string, tenantId: string, args: string[], flags: CliFlags): Promise<void> {
  const idArg = args[1];
  if (!idArg) {
    fail('Usage: hippo handoff show <id> [--json]');
  }

  const handoffId = parseInt(idArg, 10);
  if (!Number.isFinite(handoffId) || handoffId <= 0) {
    fail(`Invalid handoff ID: ${idArg}`);
  }

  const handoff = await handoffById(cliApiContext(hippoRoot, tenantId), handoffId);

  if (!handoff) {
    if (flags['json']) {
      console.log(JSON.stringify({ handoff: null }));
    } else {
      console.log(`No handoff found with ID ${handoffId}.`);
    }
    return;
  }

  if (flags['json']) {
    console.log(JSON.stringify({ handoff }, null, 2));
    return;
  }

  printHandoff(handoff);
}

export async function handleHandoff({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'latest';
  if (subcommand === 'create') return handoffCreate(hippoRoot, tenantId, flags);
  if (subcommand === 'latest') return handoffLatest(hippoRoot, tenantId, flags);
  if (subcommand === 'show') return handoffShow(hippoRoot, tenantId, args, flags);

  fail('Usage: hippo handoff <create|latest|show>');
}

function printCurrentState(snapshot: TaskSnapshot | null, events: SessionEvent[]): void {
  console.log('# Current State\n');

  if (snapshot) {
    console.log(`Task: ${snapshot.task}`);
    console.log(`Status: ${snapshot.status} | Source: ${snapshot.source} | Updated: ${snapshot.updated_at}`);
    if (snapshot.session_id) {
      console.log(`Session: ${snapshot.session_id}`);
    }
    console.log(`Summary: ${snapshot.summary}`);
    console.log(`Next: ${snapshot.next_step}`);
  } else {
    console.log('No active task snapshot.');
  }

  if (events.length > 0) {
    console.log('');
    console.log('Recent events:');
    for (const ev of events) {
      const ts = ev.created_at.slice(0, ISO_DATETIME_CHARS).replace('T', ' ');
      console.log(`  [${ts}] (${ev.event_type}) ${ev.content}`);
    }
  }
}

async function currentShow(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const asJson = boolFlag(flags, 'json');
  const { snapshot, events } = await continuityLatest(cliApiContext(hippoRoot, tenantId), { limit: 5 });

  if (asJson) {
    console.log(JSON.stringify({
      snapshot: snapshot ?? null,
      events: events.map((ev) => ({
        id: ev.id,
        session_id: ev.session_id,
        event_type: ev.event_type,
        content: ev.content,
        created_at: ev.created_at,
      })),
    }));
    return;
  }

  if (!snapshot && events.length === 0) {
    console.log('No active task or recent session events.');
    return;
  }

  printCurrentState(snapshot, events);
}

export async function handleCurrent({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'show') return currentShow(hippoRoot, tenantId, flags);

  fail('Usage: hippo current <show>');
}

// Working Memory

export async function handleWm({ hippoRoot, tenantId, args, flags }: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? '';
  if (subcommand === 'push') return wmPushCmd(hippoRoot, tenantId, flags);
  if (subcommand === 'read') return wmReadCmd(hippoRoot, tenantId, flags);

  if (subcommand === 'clear') {
    const scope = stringFlagOrExit(flags, 'scope') || undefined;
    const sessionId = stringFlagOrExit(flags, 'session') || undefined;

    const count = await workingMemoryClear(cliApiContext(hippoRoot, tenantId), { scope, sessionId });
    console.log(`Cleared ${count} working memory entries.`);
    return;
  }

  if (subcommand === 'flush') {
    const scope = stringFlagOrExit(flags, 'scope') || undefined;
    const sessionId = stringFlagOrExit(flags, 'session') || undefined;

    const count = await workingMemoryFlush(cliApiContext(hippoRoot, tenantId), { scope, sessionId });
    console.log(`Flushed ${count} working memory entries.`);
    return;
  }

  fail('Usage: hippo wm <push|read|clear|flush>');
}

const WM_DEFAULT_IMPORTANCE = 0.5;

async function wmPushCmd(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const scope = stringFlagOrExit(flags, 'scope') ?? 'default';
  const content = stringFlagOrExit(flags, 'content') ?? '';
  const importance = numberFlag(flags, 'importance') ?? WM_DEFAULT_IMPORTANCE;
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  const taskId = stringFlagOrExit(flags, 'task') || undefined;

  if (!content) {
    fail('Usage: hippo wm push --scope <scope> --content "..." [--importance 0.8] [--session <id>] [--task <id>]');
  }

  const id = await workingMemoryPush(cliApiContext(hippoRoot, tenantId), {
    scope,
    content,
    importance,
    sessionId,
    taskId,
  });

  console.log(`Pushed working memory #${id} (scope=${scope}, importance=${importance})`);
}

async function wmReadCmd(hippoRoot: string, tenantId: string, flags: CliFlags): Promise<void> {
  const scope = stringFlagOrExit(flags, 'scope') || undefined;
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  const limit = numberFlag(flags, 'limit') || 20;

  const items = await workingMemoryRead(cliApiContext(hippoRoot, tenantId), { scope, sessionId, limit });

  if (flags['json']) {
    console.log(JSON.stringify({ items }, null, 2));
    return;
  }

  if (items.length === 0) {
    console.log('No working memory entries.');
    return;
  }

  console.log(`Working memory (${items.length} entries):\n`);
  for (const item of items) {
    const sessionLabel = item.sessionId ? ` session=${item.sessionId}` : '';
    const taskLabel = item.taskId ? ` task=${item.taskId}` : '';
    console.log(`  #${item.id} [${item.scope}] importance=${item.importance}${sessionLabel}${taskLabel}`);
    console.log(`    ${item.content}`);
    console.log(`    created=${item.createdAt}`);
    console.log('');
  }
}
