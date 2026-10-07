// A session that ends without compacting still gets a handoff, read from its own transcript.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PRE_COMPACT_NEXT_STEP_CAP, PRE_COMPACT_SUMMARY_CAP, PRE_COMPACT_TASK_CAP, transcriptWorkingState } from '../src/capture/working-state.js';
import { initStore } from '../src/store/open.js';
import { loadActiveTaskSnapshot, saveActiveTaskSnapshot } from '../src/store/sessions.js';
import { loadLatestHandoff, saveSessionHandoff, writeSessionEndHandoff } from '../src/store/handoffs.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';

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

function handoffCount(root: string, sessionId: string): number {
  const db = openHippoDb(root);
  try {
    // SAFETY: COUNT(*) returns exactly one row with the n column.
    return (db.prepare(`SELECT COUNT(*) AS n FROM session_handoffs WHERE session_id = ?`).get(sessionId) as { n: number }).n;
  } finally {
    closeHippoDb(db);
  }
}

describe('transcriptWorkingState', () => {
  it('reads the last request and reply, with secrets scrubbed', () => {
    const file = transcript([
      user('set up the webhook handler'),
      assistant('Handler wired.'),
      user(`add rate limiting; the staging key is ${FAKE_KEY}`),
      assistant(`Adding the limiter next, with ${FAKE_KEY} for staging.`),
    ]);

    const derived = transcriptWorkingState(file, () => {});
    expect(derived!.task).toContain('add rate limiting');
    expect(derived!.next_step).toBe('Adding the limiter next, with [REDACTED] for staging.');
    expect(JSON.stringify(derived)).not.toContain(FAKE_KEY);
  });

  it('scrubs Bearer tokens and JWTs from every field', () => {
    const bearer = 'Bearer ' + 'A'.repeat(20);
    const jwt = 'eyJ' + 'A'.repeat(10) + '.eyJ' + 'B'.repeat(10) + '.' + 'C'.repeat(10);
    const file = transcript([user(`call the webhook with ${bearer} and ${jwt}`), assistant(`Called it with ${bearer} and ${jwt}.`)]);

    const derived = transcriptWorkingState(file, () => {});
    for (const field of [derived!.task, derived!.summary, derived!.next_step]) {
      expect(field).toContain('[REDACTED]');
      expect(field).not.toContain(bearer);
      expect(field).not.toContain(jwt);
    }
  });

  it('caps each field', () => {
    const marker = '[...earlier turns trimmed]\n';
    const file = transcript([user('u'.repeat(1000)), assistant('a'.repeat(3000)), user('v'.repeat(1000)), assistant('b'.repeat(3000))]);

    const derived = transcriptWorkingState(file, () => {});
    expect(derived!.task).toBe('v'.repeat(PRE_COMPACT_TASK_CAP));
    expect(derived!.next_step).toBe('b'.repeat(PRE_COMPACT_NEXT_STEP_CAP));
    expect(derived!.summary.startsWith(marker)).toBe(true);
    expect(derived!.summary.length).toBeLessThanOrEqual(PRE_COMPACT_SUMMARY_CAP + marker.length);
  });

  it('looks past a tail of tool output for the last request and reply', () => {
    const toolResult = { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x'.repeat(10 * 1024) }] } };
    const log: string[] = [];
    const file = transcript([user('ship the search-back fix'), assistant('Reading further back next.'), ...Array(40).fill(toolResult)]);

    const derived = transcriptWorkingState(file, (m) => log.push(m));
    expect(derived!.task).toBe('ship the search-back fix');
    expect(derived!.next_step).toBe('Reading further back next.');
    expect(log).toEqual(['tail window grown to 1048576 bytes (last user turn is further back)']);
  });

  it('reads a VS Code prompt stored as text blocks, without its IDE context', () => {
    const vscodePrompt = (...texts: string[]) => ({ type: 'user', message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) } });
    const file = transcript([
      vscodePrompt('<ide_opened_file>The user opened src/limiter.ts</ide_opened_file>', 'add rate limiting to the webhook'),
      assistant('Adding the limiter.'),
      vscodePrompt('[Request interrupted by user]'),
    ]);

    const derived = transcriptWorkingState(file, () => {});
    expect(derived!.task).toBe('add rate limiting to the webhook');
    expect(derived!.summary).not.toContain('ide_opened_file');
    expect(derived!.summary).not.toContain('Request interrupted');
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

  it("replaces the handoff read at a resumed session's earlier exit", () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state);
    const later = { ...state, next_step: 'write the retry queue test' };

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, later)?.nextAction).toBe(later.next_step);
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.evidence?.derivedFrom).toBe('transcript');
  });

  it('rewrites its earlier transcript read in place when asked, as a close after every reply does', () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state, undefined, { inPlace: true });
    const later = { ...state, next_step: 'write the retry queue test' };

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, later, undefined, { inPlace: true })?.nextAction).toBe(later.next_step);
    expect(handoffCount(root, 'sess-new')).toBe(1);
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.evidence?.derivedFrom).toBe('transcript');
  });

  it('in place still keeps a handoff written by hand', () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state, undefined, { inPlace: true });
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-new', summary: 'written by hand', artifacts: [], evidence: { testStatus: 'pass' } });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, { ...state, next_step: 'newer' }, undefined, { inPlace: true })).toBeNull();
    expect(handoffCount(root, 'sess-new')).toBe(2);
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.summary).toBe('written by hand');
  });

  it('in place adds no row when a handoff written by hand lands between the read and the rewrite', () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state, undefined, { inPlace: true });
    const db = openHippoDb(root);
    try {
      // The rewrite finds the hand-written row newest and changes nothing, as when `hippo handoff create` wins the race.
      db.exec(`CREATE TRIGGER hand_written_lands BEFORE UPDATE ON session_handoffs BEGIN
        INSERT INTO session_handoffs(session_id, summary, artifacts_json, tenant_id, created_at)
          VALUES (OLD.session_id, 'written by hand', '[]', OLD.tenant_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        SELECT RAISE(IGNORE);
      END`);
    } finally {
      closeHippoDb(db);
    }

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, { ...state, next_step: 'newer' }, undefined, { inPlace: true })).toBeNull();
    expect(handoffCount(root, 'sess-new')).toBe(2);
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.summary).toBe('written by hand');
  });

  it('in place, two replies after a compaction both refresh the handoff, as the open snapshot gives way to the transcript', () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state, undefined, { inPlace: true });
    saveActiveTaskSnapshot(root, 'default', { task: 'compacted', summary: 's', next_step: 'from the snapshot', session_id: 'sess-new', source: 'pre-compact' });

    for (const next_step of ['first reply after compaction', 'second reply after compaction']) {
      expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, { ...state, next_step }, undefined, { inPlace: true })?.nextAction).toBe(next_step);
      expect(loadLatestHandoff(root, 'default', 'sess-new')?.nextAction).toBe(next_step);
    }
    expect(handoffCount(root, 'sess-new')).toBe(1);
    expect(loadActiveTaskSnapshot(root, 'default')?.session_id).toBe('sess-new');
  });

  it('keeps a handoff written with hippo handoff create over a later transcript read', () => {
    const root = store();
    writeSessionEndHandoff(root, 'default', 'sess-new', null, state);
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-new', summary: 'written by hand', artifacts: [], evidence: { testStatus: 'pass' } });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, state)).toBeNull();
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.summary).toBe('written by hand');
  });

  it('keeps an unmarked handoff written before transcript reads were marked', () => {
    const root = store();
    const unmarked = { gitRef: 'abc123', dirtyTree: false, testStatus: 'unknown' as const };
    saveSessionHandoff(root, 'default', { version: 1, sessionId: 'sess-new', taskId: state.task, summary: state.summary, nextAction: state.next_step, artifacts: [], evidence: unmarked });

    expect(writeSessionEndHandoff(root, 'default', 'sess-new', null, { ...state, next_step: 'newer' })).toBeNull();
    expect(loadLatestHandoff(root, 'default', 'sess-new')?.nextAction).toBe(state.next_step);
  });
});
