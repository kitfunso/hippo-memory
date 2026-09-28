// A session that ends without compacting still gets a handoff, read from its own transcript.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { transcriptWorkingState } from '../src/capture.js';
import {
  initStore,
  loadActiveTaskSnapshot,
  loadLatestHandoff,
  saveActiveTaskSnapshot,
  saveSessionHandoff,
  writeSessionEndHandoff,
} from '../src/store.js';

// AWS's documented example key, a placeholder that is safe to embed.
const FAKE_KEY = 'AKIAIOSFODNN7EXAMPLE';
const state = { task: 'add rate limiting to the webhook', summary: 'handler wired, limiter next', next_step: 'write the limiter test' };

const made: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-end-handoff-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function transcript(entries: unknown[]): string {
  const file = path.join(tmp(), 'session.jsonl');
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

const user = (content: string) => ({ type: 'user', message: { role: 'user', content } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function store(): string {
  const root = tmp();
  initStore(root);
  return root;
}

describe('transcriptWorkingState', () => {
  it('reads the last request and reply, with secrets scrubbed', () => {
    const file = transcript([
      user('set up the webhook handler'),
      assistant('Handler wired.'),
      user(`add rate limiting; the staging key is ${FAKE_KEY}`),
      assistant('Adding the limiter next.'),
    ]);

    const derived = transcriptWorkingState(file, () => {});
    expect(derived!.task).toContain('add rate limiting');
    expect(derived!.next_step).toBe('Adding the limiter next.');
    expect(JSON.stringify(derived)).not.toContain(FAKE_KEY);
  });

  it('returns null and logs why when the transcript has nothing to read', () => {
    const log: string[] = [];
    expect(transcriptWorkingState(transcript([{ type: 'summary' }]), (m) => log.push(m))).toBeNull();
    expect(log).toEqual(['skip: empty summary']);
  });
});

describe('writeSessionEndHandoff from transcript state', () => {
  it('writes the handoff for a session that never saved a snapshot', () => {
    const root = store();
    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, state)).toMatchObject({
      taskId: state.task,
      summary: state.summary,
      nextAction: state.next_step,
    });
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.taskId).toBe(state.task);
  });

  it("leaves another session's active snapshot in place", () => {
    const root = store();
    saveActiveTaskSnapshot(root, 'default', { task: 'other work', summary: 's', next_step: 'n', session_id: 'sess-other' });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, state)?.taskId).toBe(state.task);
    expect(loadActiveTaskSnapshot(root, 'default')?.session_id).toBe('sess-other');
  });

  it('keeps a handoff the session already wrote', () => {
    const root = store();
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-new', summary: 'written by hand', artifacts: [] });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, state)).toBeNull();
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.summary).toBe('written by hand');
  });

  it("prefers the session's own snapshot", () => {
    const root = store();
    saveActiveTaskSnapshot(root, 'default', { task: 'from the snapshot', summary: 's', next_step: 'n', session_id: 'sess-new' });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, state)?.taskId).toBe('from the snapshot');
  });
});
