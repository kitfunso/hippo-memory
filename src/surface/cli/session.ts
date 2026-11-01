// `hippo session`: log, show, complete and resume one agent session.

import { continuityLatest } from '../../api/continuity/continuity.js';
import { cliApiContext, cliStore } from './api-context.js';
import {
  isHandoffOutcome,
  formatHandoffEvidenceLine,
  type HandoffOutcome,
} from '../../base/session/handoff.js';
import { sessionEventJson, snapshotJson } from '../../api/continuity/continuity-json.js';
import { requireInit } from './shared.js';
import { printActiveTaskSnapshot, printSessionEvents } from './print.js';
import {
  type CliFlags,
  boolFlag,
  numberFlag,
  stringFlagOrExit,
  type CommandContext,
} from './flag-values.js';
import { fail } from './exit.js';
import { SESSION_EVENT_LIMIT } from '../../base/util/limits.js';

/** The flags every `hippo session` subcommand reads up front. */
interface SessionArgs {
  readonly sessionId: string;
  readonly task: string;
  readonly limit: number;
}

async function sessionLog(
  hippoRoot: string,
  tenantId: string,
  s: SessionArgs,
  flags: CliFlags,
): Promise<void> {
  const eventType = stringFlagOrExit(flags, 'type') ?? 'note';
  const content = stringFlagOrExit(flags, 'content') ?? '';

  if (!s.sessionId || !content) {
    fail(
      'Usage: hippo session log --id <session-id> --content <text> [--type <type>] [--task <task>] ' +
        '[--source <source>]',
    );
  }

  const event = await cliStore(hippoRoot).sessions.save(tenantId, 'event', {
    sessionId: s.sessionId,
    task: s.task || null,
    eventType: eventType || 'note',
    content,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
  });

  console.log(`Logged session event #${event.id}`);
  console.log(`   Session: ${event.sessionId}`);
  console.log(`   Type: ${event.eventType}`);
}

async function sessionShow(
  hippoRoot: string,
  tenantId: string,
  s: SessionArgs,
  flags: CliFlags,
): Promise<void> {
  const events = await cliStore(hippoRoot).sessions.read(tenantId, 'event', {
    sessionId: s.sessionId || undefined,
    task: s.task || undefined,
    limit: s.limit,
  });

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ events: events.map(sessionEventJson) }, null, 2));
    return;
  }

  printSessionEvents(events);
}

async function sessionLatest(
  hippoRoot: string,
  tenantId: string,
  s: SessionArgs,
  flags: CliFlags,
): Promise<void> {
  const { snapshot, events } = await continuityLatest(cliApiContext(hippoRoot, tenantId), {
    sessionId: s.sessionId,
    limit: s.limit,
  });

  if (boolFlag(flags, 'json')) {
    console.log(
      JSON.stringify(
        {
          snapshot: snapshot ? snapshotJson(snapshot) : null,
          events: events.map(sessionEventJson),
        },
        null,
        2,
      ),
    );
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

async function sessionComplete(
  hippoRoot: string,
  tenantId: string,
  s: SessionArgs,
  flags: CliFlags,
): Promise<void> {
  const { sessionId, task } = s;
  const outcomeRaw = stringFlagOrExit(flags, 'outcome') ?? '';
  const summary = stringFlagOrExit(flags, 'summary') ?? '';

  if (!sessionId) {
    fail(
      'Usage: hippo session complete --session <session-id> --outcome <success|failure|partial> [--summary "..."]',
    );
  }
  if (!isHandoffOutcome(outcomeRaw)) {
    fail(`Invalid outcome: "${outcomeRaw}". Must be one of: success, failure, partial.`);
  }
  const outcome: HandoffOutcome = outcomeRaw;

  const metadata: SessionCompleteMetadata = { ended_at: new Date().toISOString() };
  if (summary) metadata.summary = summary;

  const event = await cliStore(hippoRoot).sessions.save(tenantId, 'event', {
    sessionId,
    task: task || null,
    eventType: 'session_complete',
    content: outcome,
    source: stringFlagOrExit(flags, 'source') ?? 'cli',
    metadata,
  });

  console.log(`Completed session ${event.sessionId} with outcome=${outcome} (event #${event.id})`);

  const stamped = await cliStore(hippoRoot).sessions.save(tenantId, 'handoff', {
    sessionId,
    outcome,
  });
  if (stamped > 0) {
    console.log(`Stamped outcome on handoff for session ${sessionId}`);
  }
}

export async function handleSession({
  hippoRoot,
  tenantId,
  args,
  flags,
}: CommandContext): Promise<void> {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';
  const sessionId = stringFlagOrExit(flags, 'id') ?? stringFlagOrExit(flags, 'session') ?? '';
  const task = stringFlagOrExit(flags, 'task') ?? '';
  const limit = Math.max(1, numberFlag(flags, 'limit') || SESSION_EVENT_LIMIT);
  const s: SessionArgs = { sessionId, task, limit };

  if (subcommand === 'log') return sessionLog(hippoRoot, tenantId, s, flags);
  if (subcommand === 'show') return sessionShow(hippoRoot, tenantId, s, flags);
  if (subcommand === 'latest') return sessionLatest(hippoRoot, tenantId, s, flags);
  if (subcommand === 'complete') return sessionComplete(hippoRoot, tenantId, s, flags);
  if (subcommand === 'resume') return sessionResume({ hippoRoot, tenantId, sessionId });

  fail('Usage: hippo session <log|show|latest|resume|complete>');
}

interface SessionResumeOptions {
  readonly hippoRoot: string;
  readonly tenantId: string;
  readonly sessionId: string;
}

async function sessionResume({
  hippoRoot,
  tenantId,
  sessionId,
}: SessionResumeOptions): Promise<void> {
  const query = { sessionId: sessionId || null };
  const handoff = await cliStore(hippoRoot).sessions.read(tenantId, 'handoff', query, null);
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
