// The store-free readers on the session-text subpath: the working-state caps a sent state is checked against, and handoff git evidence.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  PRE_COMPACT_NEXT_STEP_CAP,
  PRE_COMPACT_SUMMARY_CAP,
  PRE_COMPACT_TASK_CAP,
  WORKING_STATE_CAPS,
  transcriptWorkingState,
  truncateKeepNewest,
} from '../src/capture/working-state.js';
import { collectHandoffEvidence } from '../src/handoff-evidence.js';

const made: string[] = [];
const tmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-text-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
}

describe('WORKING_STATE_CAPS', () => {
  it('is the longest each derived field can be, the summary counting its trim marker', () => {
    expect(WORKING_STATE_CAPS.task).toBe(PRE_COMPACT_TASK_CAP);
    expect(WORKING_STATE_CAPS.next_step).toBe(PRE_COMPACT_NEXT_STEP_CAP);
    expect(truncateKeepNewest('x'.repeat(PRE_COMPACT_SUMMARY_CAP * 3), PRE_COMPACT_SUMMARY_CAP)).toHaveLength(WORKING_STATE_CAPS.summary);
  });

  it('holds every field a long transcript derives', () => {
    const file = path.join(tmp(), 't.jsonl');
    const turns = Array.from({ length: 40 }, (_, i) => [
      { type: 'user', message: { role: 'user', content: `turn ${i} ${'u'.repeat(400)}` } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ${'a'.repeat(900)}` }] } },
    ]).flat();
    fs.writeFileSync(file, turns.map((t) => JSON.stringify(t)).join('\n') + '\n');
    const state = transcriptWorkingState(file, () => {});
    expect(state).not.toBeNull();
    expect(state!.task.length).toBe(WORKING_STATE_CAPS.task);
    expect(state!.next_step.length).toBe(WORKING_STATE_CAPS.next_step);
    expect(state!.summary.length).toBeLessThanOrEqual(WORKING_STATE_CAPS.summary);
  });
});

describe('collectHandoffEvidence', () => {
  it('reads the commit and a clean then dirty tree in a repo', () => {
    const repo = tmp();
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const clean = collectHandoffEvidence(repo, 'pass');
    expect(clean).toEqual({ gitRef: expect.stringMatching(/^[0-9a-f]{40}$/), dirtyTree: false, testStatus: 'pass' });
    fs.writeFileSync(path.join(repo, 'new.txt'), 'x');
    expect(collectHandoffEvidence(repo, 'unknown').dirtyTree).toBe(true);
  });

  it('gives null fields outside a repo instead of throwing', () => {
    const dir = tmp();
    vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
    expect(collectHandoffEvidence(dir, 'unknown')).toEqual({ gitRef: null, dirtyTree: null, testStatus: 'unknown' });
  });
});
