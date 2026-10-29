// Where-you-left-off verbs that read or save the live state: snapshot, current and working memory.

import { CONTINUITY_EVENT_LIMIT, continuityLatest } from '../../api/continuity/continuity.js';
import type { SessionEvent, TaskSnapshot } from '../../base/ports/store/sessions.js';
import { snapshotJson } from '../../base/session/continuity-json.js';
import { requireInit } from './shared.js';
import { printActiveTaskSnapshot } from './print.js';
import { boolFlag, numberFlag, stringFlagOrExit, type CommandContext } from './flag-values.js';
import { fail } from './exit.js';
import { WM_DEFAULT_IMPORTANCE } from './flag-defaults.js';
import { WM_MAX_ENTRIES } from '../../base/util/limits.js';

const ISO_DATETIME_CHARS = 19;

async function snapshotSave({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
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

  const snapshot = await cli.store(hippoRoot).hippoDb.sessions.save(
    tenantId,
    'snapshot',
    {
      task,
      summary,
      nextStep,
      source: stringFlagOrExit(flags, 'source') ?? 'cli',
      sessionId: sessionId || null,
    },
    null,
  );

  console.log(`Saved active task snapshot #${snapshot.id}`);
  console.log(`   Task: ${snapshot.task}`);
  console.log(`   Next: ${snapshot.nextStep}`);
  if (snapshot.sessionId) {
    console.log(`   Session: ${snapshot.sessionId}`);
  }
}

async function snapshotClear({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const status = stringFlagOrExit(flags, 'status') ?? 'cleared';
  const cleared = await cli
    .store(hippoRoot)
    .hippoDb.sessions.clear(tenantId, 'snapshot', { status });
  if (cleared === 0) {
    console.log('No active task snapshot to clear.');
    return;
  }
  console.log('Cleared active task snapshot.');
}

async function snapshotShow({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const snapshot = await cli.store(hippoRoot).hippoDb.sessions.loadSnapshot(tenantId, {}, null);
  if (!snapshot) {
    if (boolFlag(flags, 'json')) {
      console.log(JSON.stringify({ snapshot: null }));
    } else {
      console.log('No active task snapshot saved.');
    }
    return;
  }

  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ snapshot: snapshotJson(snapshot) }, null, 2));
    return;
  }

  printActiveTaskSnapshot(snapshot);
}

export async function handleSnapshot(cmd: CommandContext): Promise<void> {
  const { hippoRoot, args } = cmd;
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'save') return snapshotSave(cmd);
  if (subcommand === 'clear') return snapshotClear(cmd);
  if (subcommand === 'show') return snapshotShow(cmd);

  fail('Usage: hippo snapshot <save|show|clear>');
}

function printCurrentState(snapshot: TaskSnapshot | null, events: SessionEvent[]): void {
  console.log('# Current State\n');

  if (snapshot) {
    console.log(`Task: ${snapshot.task}`);
    console.log(
      `Status: ${snapshot.status} | Source: ${snapshot.source} | Updated: ${snapshot.updatedAt}`,
    );
    if (snapshot.sessionId) {
      console.log(`Session: ${snapshot.sessionId}`);
    }
    console.log(`Summary: ${snapshot.summary}`);
    console.log(`Next: ${snapshot.nextStep}`);
  } else {
    console.log('No active task snapshot.');
  }

  if (events.length > 0) {
    console.log('');
    console.log('Recent events:');
    for (const ev of events) {
      const ts = ev.createdAt.slice(0, ISO_DATETIME_CHARS).replace('T', ' ');
      console.log(`  [${ts}] (${ev.eventType}) ${ev.content}`);
    }
  }
}

async function currentShow({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const asJson = boolFlag(flags, 'json');
  const { snapshot, events } = await continuityLatest(cli.apiContext(hippoRoot, tenantId), {
    limit: CONTINUITY_EVENT_LIMIT,
  });

  if (asJson) {
    console.log(
      JSON.stringify({
        snapshot: snapshot ? snapshotJson(snapshot) : null,
        events: events.map((ev) => ({
          id: ev.id,
          session_id: ev.sessionId,
          event_type: ev.eventType,
          content: ev.content,
          created_at: ev.createdAt,
        })),
      }),
    );
    return;
  }

  if (!snapshot && events.length === 0) {
    console.log('No active task or recent session events.');
    return;
  }

  printCurrentState(snapshot, events);
}

export async function handleCurrent(cmd: CommandContext): Promise<void> {
  const { hippoRoot, args } = cmd;
  requireInit(hippoRoot);

  const subcommand = args[0] ?? 'show';

  if (subcommand === 'show') return currentShow(cmd);

  fail('Usage: hippo current <show>');
}

export async function handleWm(cmd: CommandContext): Promise<void> {
  const { hippoRoot, tenantId, args, flags, cli } = cmd;
  requireInit(hippoRoot);

  const subcommand = args[0] ?? '';
  if (subcommand === 'push') return wmPushCmd(cmd);
  if (subcommand === 'read') return wmReadCmd(cmd);

  if (subcommand === 'clear') {
    const scope = stringFlagOrExit(flags, 'scope') || undefined;
    const sessionId = stringFlagOrExit(flags, 'session') || undefined;

    const count = await cli.store(hippoRoot).hippoDb.sessions.clear(tenantId, 'working_memory', {
      scope,
      sessionId,
    });
    console.log(`Cleared ${count} working memory entries.`);
    return;
  }

  if (subcommand === 'flush') {
    const scope = stringFlagOrExit(flags, 'scope') || undefined;
    const sessionId = stringFlagOrExit(flags, 'session') || undefined;

    const count = await cli.store(hippoRoot).hippoDb.sessions.clear(tenantId, 'working_memory', {
      scope,
      sessionId,
    });
    console.log(`Flushed ${count} working memory entries.`);
    return;
  }

  fail('Usage: hippo wm <push|read|clear|flush>');
}

async function wmPushCmd({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const scope = stringFlagOrExit(flags, 'scope') ?? 'default';
  const content = stringFlagOrExit(flags, 'content') ?? '';
  const importance = numberFlag(flags, 'importance') ?? WM_DEFAULT_IMPORTANCE;
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  const taskId = stringFlagOrExit(flags, 'task') || undefined;

  if (!content) {
    fail(
      'Usage: hippo wm push --scope <scope> --content "..." [--importance 0.8] [--session <id>] [--task <id>]',
    );
  }

  const id = await cli.store(hippoRoot).hippoDb.sessions.save(tenantId, 'working_memory', {
    scope,
    content,
    importance,
    sessionId,
    taskId,
  });

  console.log(`Pushed working memory #${id} (scope=${scope}, importance=${importance})`);
}

async function wmReadCmd({ cli, hippoRoot, tenantId, flags }: CommandContext): Promise<void> {
  const scope = stringFlagOrExit(flags, 'scope') || undefined;
  const sessionId = stringFlagOrExit(flags, 'session') || undefined;
  const limit = numberFlag(flags, 'limit') || WM_MAX_ENTRIES;

  const items = await cli.store(hippoRoot).hippoDb.sessions.read(tenantId, 'working_memory', {
    scope,
    sessionId,
    limit,
  });

  if (boolFlag(flags, 'json')) {
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
    console.log(
      `  #${item.id} [${item.scope}] importance=${item.importance}${sessionLabel}${taskLabel}`,
    );
    console.log(`    ${item.content}`);
    console.log(`    created=${item.createdAt}`);
    console.log('');
  }
}
