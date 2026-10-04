/**
 * Desktop usage reader: Claude Code transcripts (usage counted once per API
 * message id, subagents folded into their session) joined to hippo's token
 * ledger by session id. Fixture transcripts in the real line format.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { recordTokenUse } from '../src/token-ledger.js';
import { readTranscript, readProjects, readLedger, report } from '../scripts/token-eval/claude-usage.mjs';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function usage(w: number, r: number, o: number) {
  return { input_tokens: 2, cache_creation_input_tokens: w, cache_read_input_tokens: r, output_tokens: o };
}

/** One transcript line in Claude Code's JSONL format (only the fields the reader uses). */
interface TranscriptLine {
  type: string;
  timestamp: string;
  message: { id?: string; model?: string; role?: string; content?: string | Array<{ type: string }>; usage?: ReturnType<typeof usage> };
}

function line(o: TranscriptLine): string {
  return JSON.stringify(o);
}

describe('Claude Code usage reader', () => {
  it('counts each API message once, even when it spans several lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-usage-'));
    dirs.push(dir);
    const f = join(dir, 's.jsonl');
    writeFileSync(f, [
      line({ type: 'user', timestamp: '2026-09-23T10:00:00Z', message: { role: 'user', content: 'fix the bug' } }),
      line({ type: 'assistant', timestamp: '2026-09-23T10:00:05Z', message: { id: 'msg_1', model: 'm', usage: usage(1000, 5000, 100) } }),
      line({ type: 'assistant', timestamp: '2026-09-23T10:00:06Z', message: { id: 'msg_1', model: 'm', usage: usage(1000, 5000, 100) } }),
      line({ type: 'user', timestamp: '2026-09-23T10:00:07Z', message: { role: 'user', content: [{ type: 'tool_result' }] } }),
      line({ type: 'assistant', timestamp: '2026-09-23T10:00:09Z', message: { id: 'msg_2', model: 'm', usage: usage(200, 6000, 50) } }),
      'not json',
    ].join('\n'));
    const t = readTranscript(f);
    expect(t.messages).toBe(2);
    expect(t.prompts).toBe(1);
    expect(t.usage).toEqual({ inputTokens: 4, cacheWriteTokens: 1200, cacheReadTokens: 11000, outputTokens: 150 });
    expect(t.first).toBe('2026-09-23T10:00:00Z');
    expect(t.last).toBe('2026-09-23T10:00:09Z');
  });

  it('folds subagents into their session and joins hippo ledger rows by session id', () => {
    const projects = mkdtempSync(join(tmpdir(), 'cc-projects-'));
    const hippo = mkdtempSync(join(tmpdir(), 'cc-hippo-'));
    dirs.push(projects, hippo);
    const pdir = join(projects, '-home-me-app');
    mkdirSync(join(pdir, 'sess-a', 'subagents'), { recursive: true });
    writeFileSync(join(pdir, 'sess-a.jsonl'), line({ type: 'assistant', timestamp: '2026-09-23T10:00:00Z', message: { id: 'm1', usage: usage(10_000, 100_000, 500) } }));
    writeFileSync(join(pdir, 'sess-a', 'subagents', 'agent-1.jsonl'), line({ type: 'assistant', timestamp: '2026-09-23T10:05:00Z', message: { id: 'm2', usage: usage(5_000, 20_000, 300) } }));
    writeFileSync(join(pdir, 'sess-b.jsonl'), line({ type: 'assistant', timestamp: '2026-09-23T11:00:00Z', message: { id: 'm3', usage: usage(1_000, 2_000, 10) } }));

    initStore(hippo);
    const db = openHippoDb(hippo);
    try {
      recordTokenUse(db, { tenantId: 'default', sessionId: 'sess-a', surface: 'hook', event: 'inject', items: 3, tokens: 150 });
      recordTokenUse(db, { tenantId: 'default', sessionId: 'sess-a', surface: 'hook', event: 'skip', items: 3, tokens: 150 });
    } finally {
      closeHippoDb(db);
    }

    const sessions = readProjects(projects);
    expect(sessions.map((s: { sessionId: string }) => s.sessionId).sort()).toEqual(['sess-a', 'sess-b']);
    const a = sessions.find((s: { sessionId: string }) => s.sessionId === 'sess-a');
    expect(a.subagents).toBe(1);
    expect(a.usage.cacheWriteTokens).toBe(15_000);
    expect(a.last).toBe('2026-09-23T10:05:00Z');

    const ledger = readLedger([hippo], 'default', '2000-01-01T00:00:00Z');
    const r = report(sessions, ledger);
    expect(r.sessionsWithHippoRecords).toBe(1);
    expect(r.hippoSent).toBe(150);
    expect(r.hippoSkipped).toBe(150);
    const rowA = r.rows.find((x: { sessionId: string }) => x.sessionId === 'sess-a');
    expect(rowA.hippoShareOfNewContext).toBeCloseTo(150 / (15_000 + 4), 10);
    expect(r.rows.find((x: { sessionId: string }) => x.sessionId === 'sess-b').hippo).toBeNull();
  });
});
