// A text flag with no value (`--summary` and nothing after it) exits 1; before, parseArgs's `true` was stored as the text "true".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handoffLatest, sessionEventList, snapshotLoad, workingMemoryRead } from '../src/api/continuity.js';
import { listMemories } from '../src/api/memories/memories.js';
import { cliApiContext } from '../src/cli/api-context.js';
import { handleHandoff, handleSession, handleSnapshot, handleWm } from '../src/cli/continuity.js';
import { handleConflicts, handleOutcome, handleResolve } from '../src/cli/curate.js';
import { handleContext } from '../src/cli/context.js';
import { handleEval } from '../src/cli/eval.js';
import type { CliFlags, CommandContext } from '../src/cli/flag-values.js';
import { handleGoal } from '../src/cli/goals.js';
import { handleRecall } from '../src/cli/recall.js';
import { handleRemember, handleTrace } from '../src/cli/remember.js';
import { handleCapture } from '../src/cli/session-hooks.js';
import { handleExport, handleImport } from '../src/cli/transfer.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

const STEPS = JSON.stringify([{ action: 'ran the build', observation: 'it passed' }]);

let root = '';
const c = (args: string[], flags: CliFlags): CommandContext => ({ hippoRoot: root, tenantId: 'default', args, flags });

async function stored() {
  const ctx = cliApiContext(root, 'default');
  return {
    snapshot: Boolean(await snapshotLoad(ctx)),
    events: (await sessionEventList(ctx, { limit: 50 })).length,
    handoff: Boolean(await handoffLatest(ctx)),
    working: (await workingMemoryRead(ctx, { limit: 50 })).length,
    memories: (await listMemories(ctx)).length,
  };
}
const NOTHING = { snapshot: false, events: 0, handoff: false, working: 0, memories: 0 };

beforeEach(() => {
  root = makeRoot('flag-sites', { config: { embeddings: { enabled: false } } });
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

type Row = readonly [label: string, flag: string, run: () => void | Promise<void>];

const VALUE_LESS: readonly Row[] = [
  ['snapshot save', 'task', () => handleSnapshot(c(['save'], { task: true, summary: 's', 'next-step': 'n' }))],
  ['snapshot save', 'summary', () => handleSnapshot(c(['save'], { task: 't', summary: true, 'next-step': 'n' }))],
  ['snapshot save', 'next-step', () => handleSnapshot(c(['save'], { task: 't', summary: 's', 'next-step': true }))],
  ['snapshot save', 'source', () => handleSnapshot(c(['save'], { task: 't', summary: 's', 'next-step': 'n', source: true }))],
  ['session log', 'content', () => handleSession(c(['log'], { id: 's1', content: true }))],
  ['session log', 'type', () => handleSession(c(['log'], { id: 's1', content: 'c', type: true }))],
  ['session complete', 'summary', () => handleSession(c(['complete'], { session: 's1', outcome: 'success', summary: true }))],
  ['handoff create', 'summary', () => handleHandoff(c(['create'], { summary: true }))],
  ['handoff create', 'next', () => handleHandoff(c(['create'], { summary: 'x', next: true }))],
  ['handoff create', 'session', () => handleHandoff(c(['create'], { summary: 'x', session: true }))],
  ['wm push', 'content', () => handleWm(c(['push'], { content: true }))],
  ['wm push', 'scope', () => handleWm(c(['push'], { content: 'c', scope: true }))],
  ['wm clear', 'session', () => handleWm(c(['clear'], { session: true }))],
  ['trace record', 'task', () => handleTrace(c(['record'], { task: true, steps: STEPS, outcome: 'success' }))],
  ['trace record', 'source', () => handleTrace(c(['record'], { task: 't', steps: STEPS, outcome: 'success', source: true }))],
  ['remember', 'scope', () => handleRemember(c(['the deploy runs at noon'], { scope: true }))],
  ['export', 'format', () => handleExport(c([], { format: true }))],
  ['import', 'file', () => handleImport(c([], { file: true }))],
  ['import', 'chatgpt', () => handleImport(c([], { chatgpt: true }))],
  ['import', 'vault', () => handleImport(c([], { vault: true }))],
  ['recall', 'goal', () => handleRecall(c(['deploy'], { goal: true }))],
  ['recall', 'reranker', () => handleRecall(c(['deploy'], { reranker: true }))],
  ['recall', 'outcome', () => handleRecall(c(['deploy'], { outcome: true }))],
  ['context', 'format', () => handleContext(c([], { format: true }))],
  ['conflicts', 'status', () => handleConflicts(c([], { status: true }))],
  ['outcome', 'id', () => handleOutcome(c([], { good: true, id: true }))],
  ['resolve', 'keep', () => handleResolve(c(['1'], { keep: true }))],
  ['eval', 'compare', () => handleEval(c(['corpus.json'], { compare: true }))],
  ['goal push', 'session-id', () => handleGoal(c(['push', 'ship it'], { 'session-id': true }))],
  ['capture', 'file', () => handleCapture(c([], { file: true }))],
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
    const result = await runInProcess(() => handleSnapshot(c(['save'], { task: 'ship', summary: 'half done', 'next-step': 'merge', source: 'test' })));
    expect(result.status).toBe(0);
    expect(await snapshotLoad(cliApiContext(root, 'default'))).toMatchObject({ task: 'ship', summary: 'half done', next_step: 'merge', source: 'test' });
  });

  it('session log and handoff create store the text they were given', async () => {
    const log = await runInProcess(() => handleSession(c(['log'], { id: 's1', content: 'tried the fix', type: 'attempt' })));
    expect(log.status).toBe(0);
    expect(await sessionEventList(cliApiContext(root, 'default'), { limit: 5 })).toMatchObject([{ session_id: 's1', content: 'tried the fix', event_type: 'attempt' }]);
    const made = await runInProcess(() => handleHandoff(c(['create'], { summary: 'stopped at step 2', next: 'run the suite', session: 's1' })));
    expect(made.status).toBe(0);
    expect(await handoffLatest(cliApiContext(root, 'default'), 's1')).toMatchObject({ summary: 'stopped at step 2', nextAction: 'run the suite' });
  });

  it('wm push stores the scope and content it was given', async () => {
    const result = await runInProcess(() => handleWm(c(['push'], { scope: 'plan', content: 'check the lease' })));
    expect(result.status).toBe(0);
    expect(await workingMemoryRead(cliApiContext(root, 'default'), { limit: 5 })).toMatchObject([{ scope: 'plan', content: 'check the lease' }]);
  });

  it('trace record and remember store a row from their text flags', async () => {
    const trace = await runInProcess(() => handleTrace(c(['record'], { task: 'build', steps: STEPS, outcome: 'success', session: 's1' })));
    expect(trace.status).toBe(0);
    expect(trace.stdout).toContain('Recorded trace');
    const remembered = await runInProcess(() => handleRemember(c(['the deploy runs at noon'], { scope: 'team' })));
    expect(remembered.status).toBe(0);
    expect(await listMemories(cliApiContext(root, 'default'))).toHaveLength(2);
  });

  it('export and import read their format and file flags', async () => {
    await runInProcess(() => handleRemember(c(['the deploy runs at noon'], {})));
    const md = await runInProcess(() => handleExport(c([], { format: 'markdown' })));
    expect(md.status).toBe(0);
    expect(md.stdout).toContain('the deploy runs at noon');
    const notes = join(root, 'notes');
    mkdirSync(notes);
    const file = join(notes, 'facts.md');
    writeFileSync(file, '- The cache is cleared every night\n- Rollbacks need two approvals\n');
    const imported = await runInProcess(() => handleImport(c([], { file, 'dry-run': true })));
    expect(imported.status).toBe(0);
  });

  it('recall, conflicts and context read their text flags', async () => {
    expect((await runInProcess(() => handleRecall(c(['deploy'], { goal: 'ship', outcome: 'success' })))).status).toBe(0);
    expect((await runInProcess(() => handleConflicts(c([], { status: 'resolved' })))).status).toBe(0);
    expect((await runInProcess(() => handleContext(c([], { format: 'json' })))).status).toBe(0);
  });
});
