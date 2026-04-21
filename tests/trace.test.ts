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

    const events = listSessionEvents(hippoDir, { session_id: 'sess-x' });
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
