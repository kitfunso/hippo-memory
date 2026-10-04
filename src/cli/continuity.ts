// Where-you-left-off verbs: snapshot, session, handoff, current and working memory.

import {
  saveActiveTaskSnapshot,
  loadActiveTaskSnapshot,
  clearActiveTaskSnapshot,
  appendSessionEvent,
  listSessionEvents,
  saveSessionHandoff,
  loadLatestHandoff,
  loadHandoffById,
  stampHandoffOutcome,
} from '../store.js';
import { isHandoffOutcome, formatHandoffEvidenceLine, type HandoffOutcome } from '../handoff.js';
import { resolveTenantId } from '../tenant.js';
import { wmPush, wmRead, wmClear, wmFlush } from '../working-memory.js';
import { printError } from './output.js';
import {
  requireInit,
  collectHandoffEvidence,
  printActiveTaskSnapshot,
  printSessionEvents,
  printHandoff,
} from './shared.js';

export function cmdSnapshot(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'save') {
    const task = String(flags['task'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();
    const nextStep = String(flags['next-step'] ?? '').trim();
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim();

    if (!task || !summary || !nextStep) {
      printError('Usage: hippo snapshot save --task <task> --summary <summary> --next-step <step> [--source <source>] [--session <session-id>]');
      process.exit(1);
    }

    const snapshot = saveActiveTaskSnapshot(hippoRoot, resolveTenantId({}), {
      task,
      summary,
      next_step: nextStep,
      source: String(flags['source'] ?? 'cli'),
      session_id: sessionId || null,
    });

    console.log(`Saved active task snapshot #${snapshot.id}`);
    console.log(`   Task: ${snapshot.task}`);
    console.log(`   Next: ${snapshot.next_step}`);
    if (snapshot.session_id) {
      console.log(`   Session: ${snapshot.session_id}`);
    }
    return;
  }

  if (subcommand === 'clear') {
    const cleared = clearActiveTaskSnapshot(hippoRoot, resolveTenantId({}), String(flags['status'] ?? 'cleared'));
    if (!cleared) {
      console.log('No active task snapshot to clear.');
      return;
    }
    console.log('Cleared active task snapshot.');
    return;
  }

  if (subcommand === 'show') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
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
    return;
  }

  printError('Usage: hippo snapshot <save|show|clear>');
  process.exit(1);
}

export function cmdSession(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';
  const sessionId = String(flags['id'] ?? flags['session'] ?? '').trim();
  const task = String(flags['task'] ?? '').trim();
  const limit = Math.max(1, parseInt(String(flags['limit'] ?? '8'), 10) || 8);

  if (subcommand === 'log') {
    const eventType = String(flags['type'] ?? 'note').trim();
    const content = String(flags['content'] ?? '').trim();

    if (!sessionId || !content) {
      printError('Usage: hippo session log --id <session-id> --content <text> [--type <type>] [--task <task>] [--source <source>]');
      process.exit(1);
    }

    const event = appendSessionEvent(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      task: task || null,
      event_type: eventType || 'note',
      content,
      source: String(flags['source'] ?? 'cli'),
    });

    console.log(`Logged session event #${event.id}`);
    console.log(`   Session: ${event.session_id}`);
    console.log(`   Type: ${event.event_type}`);
    return;
  }

  if (subcommand === 'show') {
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId || undefined,
      task: task || undefined,
      limit,
    });

    if (flags['json']) {
      console.log(JSON.stringify({ events }, null, 2));
      return;
    }

    printSessionEvents(events);
    return;
  }

  if (subcommand === 'latest') {
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId || snapshot?.session_id || undefined,
      limit,
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
    return;
  }

  if (subcommand === 'complete') {
    const outcomeRaw = String(flags['outcome'] ?? '').trim();
    const summary = String(flags['summary'] ?? '').trim();

    if (!sessionId) {
      printError('Usage: hippo session complete --session <session-id> --outcome <success|failure|partial> [--summary "..."]');
      process.exit(1);
    }
    if (!isHandoffOutcome(outcomeRaw)) {
      printError(`Invalid outcome: "${outcomeRaw}". Must be one of: success, failure, partial.`);
      process.exit(1);
    }
    const outcome: HandoffOutcome = outcomeRaw;

    const metadata: Record<string, unknown> = { ended_at: new Date().toISOString() };
    if (summary) metadata.summary = summary;

    const event = appendSessionEvent(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      task: task || null,
      event_type: 'session_complete',
      content: outcome,
      source: String(flags['source'] ?? 'cli'),
      metadata,
    });

    console.log(`Completed session ${event.session_id} with outcome=${outcome} (event #${event.id})`);

    const stamped = stampHandoffOutcome(hippoRoot, resolveTenantId({}), sessionId, outcome);
    if (stamped > 0) {
      console.log(`Stamped outcome on handoff for session ${sessionId}`);
    }
    return;
  }

  if (subcommand === 'resume') {
    const handoff = loadLatestHandoff(hippoRoot, resolveTenantId({}), sessionId || undefined);
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
    return;
  }

  printError('Usage: hippo session <log|show|latest|resume|complete>');
  process.exit(1);
}

export function cmdHandoff(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'latest';

  if (subcommand === 'create') {
    const summary = String(flags['summary'] ?? '').trim();
    if (!summary) {
      printError('Usage: hippo handoff create --summary "..." [--next "..."] [--session <id>] [--task <id>] [--artifact <path>...] [--constraint <text>...] [--outcome <success|failure|partial>] [--target-runtime <name>] [--card-id <id>] [--tests <pass|fail|unknown>]');
      process.exit(1);
    }

    const outcomeRaw = flags['outcome'];
    if (outcomeRaw !== undefined && !isHandoffOutcome(outcomeRaw)) {
      printError(`Invalid outcome: "${String(outcomeRaw)}". Must be one of: success, failure, partial.`);
      process.exit(1);
    }

    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || `fallback-${Date.now()}-${process.pid}`;
    const nextAction = String(flags['next'] ?? '').trim() || undefined;
    const taskId = String(flags['task'] ?? '').trim() || undefined;
    const artifactFlag = flags['artifact'];
    const artifacts: string[] = Array.isArray(artifactFlag)
      ? artifactFlag
      : (typeof artifactFlag === 'string' ? [artifactFlag] : []);
    const constraintFlag = flags['constraint'];
    const isFlagString = (v: typeof constraintFlag): v is string => typeof v === 'string';
    const constraints: string[] = Array.isArray(constraintFlag)
      ? constraintFlag
      : (isFlagString(constraintFlag) ? [constraintFlag] : []);
    for (const name of ['target-runtime', 'card-id'] as const) {
      // parseArgs turns a value-less flag into `true`; refuse rather than store "true".
      if (flags[name] === true) {
        printError(`--${name} needs a value`);
        process.exit(1);
      }
    }
    const targetRuntime = String(flags['target-runtime'] ?? '').trim() || undefined;
    const cardId = String(flags['card-id'] ?? '').trim() || undefined;
    const testStatus = String(flags['tests'] ?? '').trim();
    const evidence = collectHandoffEvidence(
      process.cwd(),
      testStatus === 'pass' || testStatus === 'fail' ? testStatus : 'unknown',
    );

    const handoff = saveSessionHandoff(hippoRoot, resolveTenantId({}), {
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
    return;
  }

  if (subcommand === 'latest') {
    const sessionId = String(flags['session'] ?? flags['id'] ?? '').trim() || undefined;
    const handoff = loadLatestHandoff(hippoRoot, resolveTenantId({}), sessionId);

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
    return;
  }

  if (subcommand === 'show') {
    const idArg = args[1];
    if (!idArg) {
      printError('Usage: hippo handoff show <id> [--json]');
      process.exit(1);
    }

    const handoffId = parseInt(idArg, 10);
    if (!Number.isFinite(handoffId) || handoffId <= 0) {
      printError(`Invalid handoff ID: ${idArg}`);
      process.exit(1);
    }

    const handoff = loadHandoffById(hippoRoot, resolveTenantId({}), handoffId);

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
    return;
  }

  printError('Usage: hippo handoff <create|latest|show>');
  process.exit(1);
}

export function cmdCurrent(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'show') {
    const asJson = Boolean(flags['json']);
    const snapshot = loadActiveTaskSnapshot(hippoRoot, resolveTenantId({}));
    const sessionId = snapshot?.session_id ?? undefined;
    const events = listSessionEvents(hippoRoot, resolveTenantId({}), {
      session_id: sessionId,
      limit: 5,
    });

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
        const ts = ev.created_at.slice(0, 19).replace('T', ' ');
        console.log(`  [${ts}] (${ev.event_type}) ${ev.content}`);
      }
    }

    return;
  }

  printError('Usage: hippo current <show>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Working Memory
// ---------------------------------------------------------------------------

export function cmdWm(
  hippoRoot: string,
  args: string[],
  flags: Record<string, string | boolean | string[]>,
): void {
  requireInit(hippoRoot);

  const subcommand = args[0] ?? '';

  if (subcommand === 'push') {
    const scope = String(flags['scope'] ?? 'default').trim();
    const content = String(flags['content'] ?? '').trim();
    const importance = parseFloat(String(flags['importance'] ?? '0.5'));
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const taskId = flags['task'] ? String(flags['task']).trim() : undefined;

    if (!content) {
      printError('Usage: hippo wm push --scope <scope> --content "..." [--importance 0.8] [--session <id>] [--task <id>]');
      process.exit(1);
    }

    const id = wmPush(hippoRoot, {
      scope,
      content,
      importance: Number.isFinite(importance) ? importance : 0.5,
      sessionId,
      taskId,
    });

    console.log(`Pushed working memory #${id} (scope=${scope}, importance=${Number.isFinite(importance) ? importance : 0.5})`);
    return;
  }

  if (subcommand === 'read') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;
    const limit = parseInt(String(flags['limit'] ?? '20'), 10) || 20;

    const items = wmRead(hippoRoot, { scope, sessionId, limit });

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
    return;
  }

  if (subcommand === 'clear') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmClear(hippoRoot, { scope, sessionId });
    console.log(`Cleared ${count} working memory entries.`);
    return;
  }

  if (subcommand === 'flush') {
    const scope = flags['scope'] ? String(flags['scope']).trim() : undefined;
    const sessionId = flags['session'] ? String(flags['session']).trim() : undefined;

    const count = wmFlush(hippoRoot, { scope, sessionId });
    console.log(`Flushed ${count} working memory entries.`);
    return;
  }

  printError('Usage: hippo wm <push|read|clear|flush>');
  process.exit(1);
}
