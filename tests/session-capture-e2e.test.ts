import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAllEntries } from '../src/store.js';

const binPath = path.resolve(process.cwd(), 'bin', 'hippo.js');

function withTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-capture-e2e-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function transcriptJsonl(userText: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: userText } }) + '\n';
}

describe('hippo capture --last-session (extractor end-to-end)', () => {
  let tmp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    tmp = withTmpDir();
    const env = { ...process.env, HIPPO_HOME: tmp.dir };
    const init = spawnSync(process.execPath, [binPath, 'init', '--no-hooks', '--no-schedule', '--no-learn'], { cwd: tmp.dir, env, stdio: 'ignore' });
    expect(init.status).toBe(0);
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it('stores 0 memories for a chit-chat transcript', () => {
    const transcript = path.join(tmp.dir, 'chitchat.jsonl');
    fs.writeFileSync(transcript, transcriptJsonl('Thanks so much for your help today, that was a great chat.'));

    const result = spawnSync(process.execPath, [binPath, 'capture', '--last-session', '--transcript', transcript], {
      cwd: tmp.dir,
      env: { ...process.env, HIPPO_HOME: tmp.dir },
    });
    expect(result.status).toBe(0);

    const hippoRoot = path.join(tmp.dir, '.hippo');
    expect(loadAllEntries(hippoRoot)).toHaveLength(0);
  });

  it('stores a subject-bearing rule sentence whole', () => {
    const transcript = path.join(tmp.dir, 'lesson.jsonl');
    fs.writeFileSync(transcript, transcriptJsonl('The deploy script must never run migrations, because the replica lags.'));

    const result = spawnSync(process.execPath, [binPath, 'capture', '--last-session', '--transcript', transcript], {
      cwd: tmp.dir,
      env: { ...process.env, HIPPO_HOME: tmp.dir },
    });
    expect(result.status).toBe(0);

    const hippoRoot = path.join(tmp.dir, '.hippo');
    const entries = loadAllEntries(hippoRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('The deploy script must never run migrations, because the replica lags.');
  });
});
