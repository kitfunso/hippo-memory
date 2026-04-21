import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { initStore, listSessionEvents, loadAllEntries } from '../src/store.js';

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
