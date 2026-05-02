import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { initStore, listSessionEvents, loadAllEntries } from '../src/store.js';
import { renderTraceContent, parseSteps } from '../src/trace.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

let tmpDir: string;
let hippoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-trace-'));
  hippoDir = path.join(tmpDir, '.hippo');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runHippo(args: string[]): string {
  const globalDir = path.join(tmpDir, 'global');
  return execFileSync(process.execPath, [HIPPO_JS, ...args], {
    env: { ...process.env, HIPPO_HOME: globalDir },
    cwd: tmpDir,
    encoding: 'utf8',
  });
}

describe('hippo session complete', () => {
  it('writes a session_complete event with outcome + summary', () => {
    initStore(hippoDir);
    runHippo([
      'session', 'complete',
      '--session', 'sess-x',
      '--outcome', 'success',
      '--summary', 'refactored auth module',
    ]);

    const events = listSessionEvents(hippoDir, 'default', { session_id: 'sess-x' });
    const complete = events.find((e) => e.event_type === 'session_complete');
    expect(complete).toBeDefined();
    expect(complete!.content).toBe('success');
    expect(complete!.metadata.summary).toBe('refactored auth module');
  });

  it('rejects invalid outcomes', () => {
    initStore(hippoDir);
    expect(() => runHippo([
      'session', 'complete',
      '--session', 'sess-x',
      '--outcome', 'not-real',
    ])).toThrow();
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
  it('creates a Trace-layer memory with outcome + steps', () => {
    initStore(hippoDir);

    runHippo([
      'trace', 'record',
      '--task', 'fix failing test suite',
      '--steps', JSON.stringify([
        { action: 'read test', observation: 'saw assertion error' },
        { action: 'edit src/foo.ts', observation: 'test passed' },
      ]),
      '--outcome', 'success',
    ]);

    const entries = loadAllEntries(hippoDir);
    const traces = entries.filter((e) => e.layer === 'trace');
    expect(traces).toHaveLength(1);
    expect(traces[0].trace_outcome).toBe('success');
    expect(traces[0].content).toContain('fix failing test suite');
    expect(traces[0].content).toContain('assertion error');
    expect(traces[0].content).toContain('test passed');
  });

  it('rejects invalid outcome values', () => {
    initStore(hippoDir);
    expect(() => runHippo([
      'trace', 'record',
      '--task', 'bad outcome',
      '--steps', '[{"action":"x","observation":"y"}]',
      '--outcome', 'not-real',
    ])).toThrow();
  });
});

describe('hippo recall --outcome filter', () => {
  it('returns only successful traces when --outcome success is set', () => {
    initStore(hippoDir);
    for (const outcome of ['success', 'failure'] as const) {
      runHippo([
        'trace', 'record',
        '--task', `refactor auth module (${outcome})`,
        '--steps', '[{"action":"edit","observation":"done"}]',
        '--outcome', outcome,
      ]);
    }

    const out = runHippo([
      'recall', 'refactor auth',
      '--outcome', 'success',
      '--json',
      '--why',
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.results.length).toBeGreaterThan(0);
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

  it('does NOT filter non-trace entries by --outcome', () => {
    initStore(hippoDir);
    // Record a failure trace
    runHippo([
      'trace', 'record',
      '--task', 'database connector patch',
      '--steps', '[{"action":"edit connector","observation":"still broken"}]',
      '--outcome', 'failure',
    ]);
    // Remember a regular episodic memory that shares some text
    runHippo([
      'remember', 'database connector patch applied successfully to staging',
    ]);

    const out = runHippo([
      'recall', 'database connector patch',
      '--outcome', 'success',
      '--json',
    ]);
    const parsed = JSON.parse(out);
    // The failure trace must be dropped; the episodic memory must survive.
    const allText = JSON.stringify(parsed);
    expect(allText).not.toContain('still broken');
    expect(allText).toContain('applied successfully to staging');
  });
});
