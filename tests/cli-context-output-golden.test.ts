// Pins `hippo context` stdout, stderr and exit code across its three formats and the per-prompt hook path,
// in process, so a split of renderContext that changes a byte fails here. Ids and timestamps are masked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS, type MemoryEntry } from '../src/core/memory.js';
import { cmdContext } from '../src/cli/context.js';
import { runInProcess } from './_helpers/run-in-process.js';

let root = '';
let store = '';

function seeded(content: string, id: string, opts: Partial<Parameters<typeof createMemory>[1]> = {}): MemoryEntry {
  return { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS, ...opts }), id, strength: 1 };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hippo-context-golden-'));
  store = join(root, 'local');
  vi.stubEnv('HIPPO_HOME', join(root, 'global'));
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('HIPPO_SESSION_ID', '');
  vi.stubEnv('CLAUDE_CODE_SESSION_ID', '');
  initStore(store);
  writeEntry(store, seeded('always run the migration dry run before deploying', 'mem_ctx_pinned', { pinned: true, tags: ['deploy'] }));
  writeEntry(store, seeded('the deploy pipeline uses blue green rollout for the api', 'mem_ctx_deploy', { tags: ['deploy'] }));
  writeEntry(store, seeded('lunch options near the office include a noodle bar', 'mem_ctx_lunch'));
  saveActiveTaskSnapshot(store, 'default', {
    task: 'ship the context split', summary: 'renderContext split by stage', next_step: 'run the goldens', session_id: 'sess-golden',
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function mask(text: string): string {
  return text
    .split(root).join('<root>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>')
    .replace(/\d{4}-\d\d-\d\d \d\d:\d\d(?::\d\d)?/g, '<ts>')
    // Scores decay by the millisecond between runs; four places still pin the ranking inputs.
    .replace(/"score":(\d+\.\d+)/g, (_m, v: string) => `"score":${Number(v).toFixed(4)}`);
}

type Flags = Record<string, string | boolean | string[]>;

describe('hippo context output (in process)', () => {
  it('prints the same bytes and exit codes in every format', async () => {
    const transcript: string[] = [];
    const step = async (label: string, args: string[], flags: Flags, stdin?: string): Promise<void> => {
      const r = await runInProcess(() => cmdContext(store, args, flags, stdin));
      transcript.push(`$ context ${label} -> ${r.status}\n--- stdout\n${mask(r.stdout)}\n--- stderr\n${mask(r.stderr)}`);
    };
    const hook = JSON.stringify({ session_id: 'sess-hook', prompt: 'how does the deploy pipeline roll out' });

    await step('markdown', ['deploy'], {});
    await step('markdown --framing assert', ['deploy'], { framing: 'assert', limit: '1' });
    await step('json', ['deploy'], { format: 'json' });
    await step('additional-context', ['deploy'], { format: 'additional-context' });
    await step('no match', ['zzqqxx'], { format: 'json', 'include-recent': '0' });
    await step('budget 0', ['deploy'], { budget: '0' });
    await step('pinned-only hook', [], { 'pinned-only': true, format: 'additional-context' }, hook);
    await step('pinned-only hook (unchanged)', [], { 'pinned-only': true, format: 'additional-context' }, hook);
    await step('pinned-only markdown', [], { 'pinned-only': true }, '{"session_id":"sess-md"}');
    await step('malformed stdin', ['deploy'], { format: 'json' }, 'not json');

    expect(transcript.join('\n')).toMatchSnapshot();
  });
});
