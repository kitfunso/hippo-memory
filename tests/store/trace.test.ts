import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { createMemory } from '../../src/base/memory/memory.js';
import { renderTraceContent, parseSteps } from '../../src/domain/consolidate/trace.js';
import { runCliOut } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { listSessionEvents, writeEntry, loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { oneRequestPerTest } from '../_helpers/one-request-per-test.js';

oneRequestPerTest();

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = makeRoot('trace', { init: false });
  hippoDir = path.join(tmpDir, '.hippo');
});

async function runHippo(args: string[]): Promise<string> {
  const globalDir = path.join(tmpDir, 'global');
  return await runCliOut(args, { env: { ...process.env, HIPPO_HOME: globalDir }, cwd: tmpDir });
}

describe('hippo session complete', () => {
  it('writes a session_complete event with outcome + summary', async () => {
    initTestStore(hippoDir);
    await runHippo([
      'session',
      'complete',
      '--session',
      'sess-x',
      '--outcome',
      'success',
      '--summary',
      'refactored auth module',
    ]);

    const events = listSessionEvents(hippoDir, 'default', { session_id: 'sess-x' });
    const complete = events.find((e) => e.eventType === 'session_complete');
    expect(complete?.content).toBe('success');
    expect(complete!.metadata.summary).toBe('refactored auth module');
  });

  it('rejects invalid outcomes', async () => {
    initTestStore(hippoDir);
    await expect(runHippo(['session', 'complete', '--session', 'sess-x', '--outcome', 'not-real'])).rejects.toThrow();
  });
});

describe('renderTraceContent', () => {
  it('renders a successful trace as markdown', () => {
    const md = renderTraceContent({
      task: 'fix failing test',
      steps: [
        { action: 'read test file', observation: 'assertion error' },
        { action: 'edit src/foo.ts:42', observation: 'test passes' },
      ],
      outcome: 'success',
    });
    expect(md).toContain('Task: fix failing test');
    expect(md).toContain('Outcome: success');
    expect(md).toContain('1. read test file');
    expect(md).toContain('\u2192 assertion error');
    expect(md).toContain('2. edit src/foo.ts:42');
  });

  it('renders a trace with no observations cleanly', () => {
    const md = renderTraceContent({
      task: 'bare task',
      steps: [{ action: 'did a thing', observation: '' }],
      outcome: 'failure',
    });
    expect(md).toContain('Outcome: failure');
    expect(md).toContain('1. did a thing');
    expect(md).not.toContain('\u2192');
  });
});

describe('parseSteps', () => {
  it('parses a JSON steps string', () => {
    const s = parseSteps('[{"action":"a","observation":"b"}]');
    expect(s).toHaveLength(1);
    expect(s[0].action).toBe('a');
    expect(s[0].observation).toBe('b');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSteps('not-json')).toThrow(/trace steps/);
  });

  it('throws on a non-array payload', () => {
    expect(() => parseSteps('{"action":"x"}')).toThrow(/array/);
  });
});

describe('hippo trace record', () => {
  it('creates a Trace-layer memory with outcome + steps', async () => {
    initTestStore(hippoDir);

    await runHippo([
      'trace',
      'record',
      '--task',
      'fix failing test suite',
      '--steps',
      JSON.stringify([
        { action: 'read test', observation: 'saw assertion error' },
        { action: 'edit src/foo.ts', observation: 'test passed' },
      ]),
      '--outcome',
      'success',
    ]);

    const entries = loadAllEntries(hippoDir, 'default');
    const traces = entries.filter((e) => e.layer === 'trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].traceOutcome).toBe('success');
    expect(traces[0].content).toContain('fix failing test suite');
    expect(traces[0].content).toContain('assertion error');
    expect(traces[0].content).toContain('test passed');
  });

  it('rejects invalid outcome values', async () => {
    initTestStore(hippoDir);
    await expect(
      runHippo([
        'trace',
        'record',
        '--task',
        'bad outcome',
        '--steps',
        '[{"action":"x","observation":"y"}]',
        '--outcome',
        'not-real',
      ]),
    ).rejects.toThrow();
  });
});

describe('hippo trace <id>', () => {
  it('shows the half-life the memory decays on, not one recomputed from a 7-day base', async () => {
    initTestStore(hippoDir);
    // 123 days is no base times a write-time multiplier, like a half-life that recalls stretched.
    const entry = {
      ...createMemory('the release checklist lives in docs/release.md', { baseHalfLifeDays: 365 }),
      halfLifeDays: 123,
    };
    writeEntry(hippoDir, entry);

    // SAFETY: printTrace --json prints these numeric fields (src/cli.ts printTrace).
    const json = JSON.parse(await runHippo(['trace', entry.id, '--json'])) as {
      half_life_days: number;
      reward_factor: number;
      effective_half_life_days: number;
    };
    expect(json.half_life_days).toBe(123);
    expect(json.effective_half_life_days).toBeCloseTo(123 * json.reward_factor, 9);
    expect(await runHippo(['trace', entry.id])).toContain('half-life:  123.0d (stored)');
  });
});

describe('hippo recall --outcome filter', () => {
  it('returns only successful traces when --outcome success is set', async () => {
    initTestStore(hippoDir);
    for (const outcome of ['success', 'failure'] as const) {
      await runHippo([
        'trace',
        'record',
        '--task',
        `refactor auth module (${outcome})`,
        '--steps',
        '[{"action":"edit","observation":"done"}]',
        '--outcome',
        outcome,
      ]);
    }

    const out = await runHippo(['recall', 'refactor auth', '--outcome', 'success', '--json', '--why']);
    const parsed = JSON.parse(out);
    expect(parsed.results).toHaveLength(1);
    for (const r of parsed.results) {
      if (r.layer === 'trace') {
        expect(r.content).toContain('Outcome: success');
        expect(r.content).not.toContain('Outcome: failure');
      }
    }
    const allText = JSON.stringify(parsed);
    expect(allText).toContain('refactor auth module (success)');
    expect(allText).not.toContain('refactor auth module (failure)');
  });

  it('does NOT filter non-trace entries by --outcome', async () => {
    initTestStore(hippoDir);
    // Record a failure trace
    await runHippo([
      'trace',
      'record',
      '--task',
      'database connector patch',
      '--steps',
      '[{"action":"edit connector","observation":"still broken"}]',
      '--outcome',
      'failure',
    ]);
    // Remember a regular episodic memory that shares some text
    await runHippo(['remember', 'database connector patch applied successfully to staging']);

    const out = await runHippo(['recall', 'database connector patch', '--outcome', 'success', '--json']);
    const parsed = JSON.parse(out);
    // The failure trace must be dropped; the episodic memory must survive.
    const allText = JSON.stringify(parsed);
    expect(allText).not.toContain('still broken');
    expect(allText).toContain('applied successfully to staging');
  });
});
