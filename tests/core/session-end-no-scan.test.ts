import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { type SpawnSyncReturns } from 'child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { getHippoRoot } from '../../src/core/project-identity.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { hippoRun } from '../_helpers/spawn-hippo.js';
import { waitFor } from '../_helpers/wait-for.js';

// OpenCode's idle hook runs `hippo session-end` with no payload. An empty stdin
// must not read as a manual run: session-end never scans ~/.claude/projects.
// Real built CLI and real detached worker, same idiom as session-end-snapshot-close.test.ts.
const MARKER = 'zebrafish-ledger';
const WORKER_DONE = 'skip: no session_id in SessionEnd payload';

function runHippo(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input?: string,
): SpawnSyncReturns<string> {
  return hippoRun(args, { cwd, env, input });
}

// The detached worker is a real process: a throw while it holds the WAL lock counts as "not yet", and the bound is generous under load.
const WORKER_WAIT = { timeoutMs: 25_000, intervalMs: 50, retryOnThrow: true } as const;

describe('session-end with no payload never scans other projects', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-end-no-scan-'));
    env = { ...process.env, HIPPO_HOME: dir, HOME: dir, USERPROFILE: dir };
    expect(runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], dir, env).status).toBe(0);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // the detached worker can still hold a Windows lock; a leftover tmpdir is harmless.
    }
  });

  it('skips capture and stores nothing from another project\'s newest transcript', async () => {
    const other = path.join(dir, '.claude', 'projects', 'other-proj');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(
      path.join(other, 'x.jsonl'),
      [
        { type: 'user', message: { role: 'user', content: `we decided to adopt the ${MARKER} cache` } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Adopted; the migration is next.' }] } },
      ].map((e) => JSON.stringify(e)).join('\n') + '\n',
    );

    const logFile = path.join(dir, 'session-end-no-payload.log');
    expect(runHippo(['session-end', '--log-file', logFile], dir, env, '').status).toBe(0);

    await waitFor(() => fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes(WORKER_DONE), { ...WORKER_WAIT, what: 'the worker skip line in the log' });
    const logText = fs.readFileSync(logFile, 'utf8');
    expect(logText).toContain('skip capture: no transcript for this session');

    let contents: string[] = [];
    await waitFor(() => {
      contents = loadAllEntries(getHippoRoot(dir), 'default').map((e) => e.content);
      return true;
    }, { ...WORKER_WAIT, what: 'the store readable' });
    expect(contents.filter((c) => c.includes(MARKER))).toEqual([]);
  });
});
