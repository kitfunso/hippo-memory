// A text flag with no value (`--summary` and nothing after it) exits 1; before, parseArgs's `true` was stored as the text "true".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryList } from '../../src/api/memories/memories.js';
import type { CliCommand } from '../../src/surface/cli/api-context.js';
import { handleHandoff } from '../../src/surface/cli/handoff.js';
import { handleSession } from '../../src/surface/cli/session.js';
import { handleSnapshot, handleWm } from '../../src/surface/cli/continuity.js';
import { handleConflicts, handleResolve } from '../../src/surface/cli/conflicts.js';
import { handleOutcome } from '../../src/surface/cli/curate.js';
import { handleContext } from '../../src/surface/cli/context.js';
import { handleEval } from '../../src/surface/cli/eval.js';
import type { CliFlags, CommandContext } from '../../src/surface/cli/flag-values.js';
import { handleGoal } from '../../src/surface/cli/goals.js';
import { handleRecall } from '../../src/surface/cli/recall.js';
import { handleRemember } from '../../src/surface/cli/remember.js';
import { handleTrace } from '../../src/surface/cli/trace.js';
import { handleCapture } from '../../src/surface/cli/hooks/capture.js';
import { handleExport } from '../../src/surface/cli/transfer.js';
import { handleImport } from '../../src/surface/cli/memory-import.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { removeDir } from '../_helpers/remove-dir.js';
import { asCommand, endLastingCommands, lastingCommand } from '../_helpers/test-cli.js';

const STEPS = JSON.stringify([{ action: 'ran the build', observation: 'it passed' }]);

let root = '';
const c = (cli: CliCommand, args: string[], flags: CliFlags): CommandContext => ({
  cli,
  hippoRoot: root,
  tenantId: 'default',
  args,
  flags,
});

async function stored() {
  return asCommand(async (cli) => {
    const ctx = cli.apiContext(root, 'default');
    const { sessions } = ctx.store.hippoDb;
    return {
      snapshot: Boolean(await sessions.loadSnapshot('default', {}, null)),
      events: (await sessions.read('default', 'event', { limit: 50 })).length,
      handoff: Boolean(await sessions.read('default', 'handoff', { sessionId: null }, null)),
      working: (await sessions.read('default', 'working_memory', { limit: 50 })).length,
      memories: (await memoryList(ctx)).length,
    };
  });
}
const sessionsOf = (hippoRoot: string) => lastingCommand().apiContext(hippoRoot, 'default').store.hippoDb.sessions;
const NOTHING = { snapshot: false, events: 0, handoff: false, working: 0, memories: 0 };

beforeEach(() => {
  root = makeRoot('flag-sites', { config: { embeddings: { enabled: false } } });
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
});

afterEach(async () => {
  await endLastingCommands();
  vi.unstubAllEnvs();
  removeDir(root);
});

type Row = readonly [label: string, flag: string, run: (cli: CliCommand) => void | Promise<void>];

const VALUE_LESS: readonly Row[] = [
  ['snapshot save', 'task', (cli) => handleSnapshot(c(cli, ['save'], { task: true, summary: 's', 'next-step': 'n' }))],
  [
    'snapshot save',
    'summary',
    (cli) => handleSnapshot(c(cli, ['save'], { task: 't', summary: true, 'next-step': 'n' })),
  ],
  [
    'snapshot save',
    'next-step',
    (cli) => handleSnapshot(c(cli, ['save'], { task: 't', summary: 's', 'next-step': true })),
  ],
  [
    'snapshot save',
    'source',
    (cli) => handleSnapshot(c(cli, ['save'], { task: 't', summary: 's', 'next-step': 'n', source: true })),
  ],
  ['session log', 'content', (cli) => handleSession(c(cli, ['log'], { id: 's1', content: true }))],
  ['session log', 'type', (cli) => handleSession(c(cli, ['log'], { id: 's1', content: 'c', type: true }))],
  [
    'session complete',
    'summary',
    (cli) => handleSession(c(cli, ['complete'], { session: 's1', outcome: 'success', summary: true })),
  ],
  ['handoff create', 'summary', (cli) => handleHandoff(c(cli, ['create'], { summary: true }))],
  ['handoff create', 'next', (cli) => handleHandoff(c(cli, ['create'], { summary: 'x', next: true }))],
  ['handoff create', 'session', (cli) => handleHandoff(c(cli, ['create'], { summary: 'x', session: true }))],
  ['wm push', 'content', (cli) => handleWm(c(cli, ['push'], { content: true }))],
  ['wm push', 'scope', (cli) => handleWm(c(cli, ['push'], { content: 'c', scope: true }))],
  ['wm clear', 'session', (cli) => handleWm(c(cli, ['clear'], { session: true }))],
  ['trace record', 'task', (cli) => handleTrace(c(cli, ['record'], { task: true, steps: STEPS, outcome: 'success' }))],
  [
    'trace record',
    'source',
    (cli) => handleTrace(c(cli, ['record'], { task: 't', steps: STEPS, outcome: 'success', source: true })),
  ],
  ['remember', 'scope', (cli) => handleRemember(c(cli, ['the deploy runs at noon'], { scope: true }))],
  ['export', 'format', (cli) => handleExport(c(cli, [], { format: true }))],
  ['import', 'file', (cli) => handleImport(c(cli, [], { file: true }))],
  ['import', 'chatgpt', (cli) => handleImport(c(cli, [], { chatgpt: true }))],
  ['import', 'vault', (cli) => handleImport(c(cli, [], { vault: true }))],
  ['recall', 'goal', (cli) => handleRecall(c(cli, ['deploy'], { goal: true }))],
  ['recall', 'reranker', (cli) => handleRecall(c(cli, ['deploy'], { reranker: true }))],
  ['recall', 'outcome', (cli) => handleRecall(c(cli, ['deploy'], { outcome: true }))],
  ['context', 'format', (cli) => handleContext(c(cli, [], { format: true }))],
  ['conflicts', 'status', (cli) => handleConflicts(c(cli, [], { status: true }))],
  ['outcome', 'id', (cli) => handleOutcome(c(cli, [], { good: true, id: true }))],
  ['resolve', 'keep', (cli) => handleResolve(c(cli, ['1'], { keep: true }))],
  ['eval', 'compare', (cli) => handleEval(c(cli, ['corpus.json'], { compare: true }))],
  ['goal push', 'session-id', (cli) => handleGoal(c(cli, ['push', 'ship it'], { 'session-id': true }))],
  ['capture', 'file', (cli) => handleCapture(c(cli, [], { file: true }))],
];

describe('a text flag with no value', () => {
  it.each(VALUE_LESS)('%s --%s exits 1 and stores nothing', async (_label, flag, run) => {
    const result = await runInProcess(run);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`--${flag} requires a value`);
    expect(await stored()).toEqual(NOTHING);
  });
});

describe('a text flag with a value', () => {
  it('snapshot save keeps the task, summary and next step it was given', async () => {
    const result = await runInProcess((cli) =>
      handleSnapshot(c(cli, ['save'], { task: 'ship', summary: 'half done', 'next-step': 'merge', source: 'test' })),
    );
    expect(result.status).toBe(0);
    expect(await sessionsOf(root).loadSnapshot('default', {}, null)).toMatchObject({
      task: 'ship',
      summary: 'half done',
      nextStep: 'merge',
      source: 'test',
    });
  });

  it('session log and handoff create store the text they were given', async () => {
    const log = await runInProcess((cli) =>
      handleSession(c(cli, ['log'], { id: 's1', content: 'tried the fix', type: 'attempt' })),
    );
    expect(log.status).toBe(0);
    expect(await sessionsOf(root).read('default', 'event', { limit: 5 })).toMatchObject([
      { sessionId: 's1', content: 'tried the fix', eventType: 'attempt' },
    ]);
    const made = await runInProcess((cli) =>
      handleHandoff(c(cli, ['create'], { summary: 'stopped at step 2', next: 'run the suite', session: 's1' })),
    );
    expect(made.status).toBe(0);
    expect(await sessionsOf(root).read('default', 'handoff', { sessionId: 's1' }, null)).toMatchObject({
      summary: 'stopped at step 2',
      nextAction: 'run the suite',
    });
  });

  it('wm push stores the scope and content it was given', async () => {
    const result = await runInProcess((cli) =>
      handleWm(c(cli, ['push'], { scope: 'plan', content: 'check the lease' })),
    );
    expect(result.status).toBe(0);
    expect(await sessionsOf(root).read('default', 'working_memory', { limit: 5 })).toMatchObject([
      { scope: 'plan', content: 'check the lease' },
    ]);
  });

  it('trace record and remember store a row from their text flags', async () => {
    const trace = await runInProcess((cli) =>
      handleTrace(c(cli, ['record'], { task: 'build', steps: STEPS, outcome: 'success', session: 's1' })),
    );
    expect(trace.status).toBe(0);
    expect(trace.stdout).toContain('Recorded trace');
    const remembered = await runInProcess((cli) =>
      handleRemember(c(cli, ['the deploy runs at noon'], { scope: 'team' })),
    );
    expect(remembered.status).toBe(0);
    expect(await asCommand((cli) => memoryList(cli.apiContext(root, 'default')))).toHaveLength(2);
  });

  it('export and import read their format and file flags', async () => {
    await runInProcess((cli) => handleRemember(c(cli, ['the deploy runs at noon'], {})));
    const md = await runInProcess((cli) => handleExport(c(cli, [], { format: 'markdown' })));
    expect(md.status).toBe(0);
    expect(md.stdout).toContain('the deploy runs at noon');
    const notes = join(root, 'notes');
    mkdirSync(notes);
    const file = join(notes, 'facts.md');
    writeFileSync(file, '- The cache is cleared every night\n- Rollbacks need two approvals\n');
    const imported = await runInProcess((cli) => handleImport(c(cli, [], { file, 'dry-run': true })));
    expect(imported.status).toBe(0);
  });

  it('recall, conflicts and context read their text flags', async () => {
    expect(
      (await runInProcess((cli) => handleRecall(c(cli, ['deploy'], { goal: 'ship', outcome: 'success' })))).status,
    ).toBe(0);
    expect((await runInProcess((cli) => handleConflicts(c(cli, [], { status: 'resolved' })))).status).toBe(0);
    expect((await runInProcess((cli) => handleContext(c(cli, [], { format: 'json' })))).status).toBe(0);
  });
});
