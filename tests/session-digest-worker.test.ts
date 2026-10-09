// End to end through bin/hippo.js: the session-end workers write the digest, and context prints the handoff or the digest, never both.
import { spawn, spawnSync, type SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionDigestId } from '../src/session-digest.js';
import { isSessionDigestRow } from '../src/core/session-digest-row.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { loadLatestHandoff, saveSessionHandoff } from '../src/store/handoffs.js';

const HIPPO_JS = fileURLToPath(new URL('../bin/hippo.js', import.meta.url));
const REPLY = 'Raised the upload timeout in `upload.ts` because large files need more than thirty seconds.';
const OTHER_REPLY = 'Split the queue worker in `queue.ts` so slow jobs no longer block quick ones.';
const CODEX_REPLY = 'Retry now waits two seconds between attempts because the queue drains slowly.';
const ROLLOUT = 'rollout-2026-09-29T10-00-00-0199aaaa';
const RULE = 'Never run npm install in the billing service';

let tmp: string;
let repo: string;
let log: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-worker-'));
  repo = path.join(tmp, 'repo');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  log = path.join(tmp, 'worker.log');
  const drop = new Set(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HIPPO_TENANT', 'HIPPO_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
    'XDG_DATA_HOME', 'HIPPO_HOME', 'HOME', 'USERPROFILE', 'PATH']);
  env = {};
  for (const [key, value] of Object.entries(process.env)) if (!drop.has(key.toUpperCase())) env[key] = value;
  // A model CLI on PATH could answer a capture step; the digest must stand without one.
  env.PATH = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => !/[\\/]npm[\\/]?$/i.test(dir)).join(path.delimiter);
  Object.assign(env, { HIPPO_HOME: path.join(tmp, 'global'), HOME: home, USERPROFILE: home, HIPPO_SKIP_AUTO_INTEGRATIONS: '1' });
  expect(hippo(['init', '--no-hooks', '--no-schedule', '--no-learn']).status).toBe(0);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function hippo(args: string[], input?: string, cwd = repo): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [HIPPO_JS, ...args], { cwd, env, input, encoding: 'utf8' });
}

function claudeTranscript(name: string, opts: { reply?: string; edited?: string; cwd?: string; prompt?: string } = {}): string {
  const cwd = opts.cwd ?? repo;
  const file = path.join(tmp, `${name}.jsonl`);
  const records = [
    { type: 'user', cwd, message: { role: 'user', content: opts.prompt ?? 'large uploads keep timing out overnight' } },
    { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: path.join(cwd, 'src', opts.edited ?? 'upload.ts') } }] } },
    { type: 'user', cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } },
    { type: 'assistant', cwd, message: { role: 'assistant', content: [{ type: 'text', text: opts.reply ?? REPLY }] } },
  ];
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const workerArgs = (sessionId: string, transcript: string): string[] =>
  ['__session-end-worker', '--transcript', transcript, '--session-id', sessionId, '--log-file', log];

function claudeWorker(sessionId: string, transcript: string): string {
  expect(hippo(workerArgs(sessionId, transcript)).status).toBe(0);
  return fs.readFileSync(log, 'utf8');
}

const digests = () => loadAllEntries(path.join(repo, '.hippo')).filter(isSessionDigestRow);

// Each worker run spawns node and runs sleep, so a busy full suite can take several times the solo run.
const SLOW = { timeout: 120_000 };

describe('the Claude Code session-end worker', SLOW, () => {
  it('writes one digest per session, a re-run keeps one, and the log never holds its text', () => {
    const transcript = claudeTranscript('s1');
    for (let run = 0; run < 2; run++) {
      const text = claudeWorker('S1', transcript);
      expect(text).toContain('digest: wrote 1 sentence(s), 1 file(s) for S1');
      expect(text).not.toContain('upload timeout');
    }
    expect(digests().map((d) => [d.id, d.content])).toEqual([[sessionDigestId('default', 'S1'), `${REPLY}\nChanged: src/upload.ts`]]);
  });

  it('two workers for the same session at once still leave one row', async () => {
    const transcript = claudeTranscript('s1');
    const run = () => new Promise<number | null>((resolve) => {
      spawn(process.execPath, [HIPPO_JS, ...workerArgs('S1', transcript)], { cwd: repo, env, stdio: 'ignore' }).on('exit', resolve);
    });
    expect(await Promise.all([run(), run()])).toEqual([0, 0]);
    expect(digests()).toHaveLength(1);
  });

  it('skips a missing transcript and a session that ran outside the repo', () => {
    expect(claudeWorker('S1', path.join(tmp, 'gone.jsonl'))).toContain('digest: skip: no transcript to read');
    expect(claudeWorker('S1', claudeTranscript('away', { cwd: tmp }))).toContain('digest: skip: the session ran outside this repo');
    expect(digests()).toEqual([]);
  });

  it('a rejected digest stays rejected on the next run', () => {
    const transcript = claudeTranscript('s1');
    claudeWorker('S1', transcript);
    expect(hippo(['reject', sessionDigestId('default', 'S1'), '--reason', 'not useful']).status).toBe(0);
    const text = claudeWorker('S1', transcript);
    expect(text).toContain('digest: skip: it matches a rejected value');
    expect(text).not.toContain('upload timeout');
    expect(digests()).toEqual([]);
  });
});

/** Writes a Codex rollout that ran in `cwd` and returns the worker's arguments. */
function codexRollout(cwd: string): string[] {
  const codexHome = path.join(tmp, 'codex');
  const dir = path.join(codexHome, 'sessions', '2026', '09', '29');
  fs.mkdirSync(dir, { recursive: true });
  const item = <T,>(payload: T) => ({ type: 'response_item', payload });
  const patch = (header: string) => `*** Begin Patch\n${header}\n+x\n*** End Patch`;
  const records = [
    { type: 'session_meta', payload: { id: '0199aaaa', cwd } },
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make the retry wait longer' }] }),
    item({ type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: patch('*** Add File: src/retry.ts') }),
    item({ type: 'custom_tool_call_output', call_id: 'c1', output: 'Success. Updated the following files:\nA src/retry.ts\n' }),
    item({ type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: patch('*** Add File: src/broken.ts') }),
    item({ type: 'custom_tool_call_output', call_id: 'c2', output: 'error: patch did not apply' }),
    item({ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: CODEX_REPLY }] }),
    item({ type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the queue settings once more.' }] }),
  ];
  fs.writeFileSync(path.join(dir, `${ROLLOUT}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return ['__codex-session-end-worker', '--codex-home', codexHome, '--history-path', path.join(codexHome, 'history.jsonl'), '--started-at', '1', '--log-file', log];
}

describe('the Codex session-end worker', SLOW, () => {
  it('keys the digest on the rollout name, uses the final answer and lists only patches that landed', () => {
    expect(hippo(codexRollout(repo)).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain(`digest: wrote 1 sentence(s), 1 file(s) for ${ROLLOUT}`);
    expect(digests().map((d) => [d.id, d.source_session_id, d.content])).toEqual([
      [sessionDigestId('default', ROLLOUT), ROLLOUT, `${CODEX_REPLY}\nChanged: src/retry.ts`],
    ]);
  });
});

describe('a folder with only the global store', SLOW, () => {
  it('gets capture and the handoff in the global store, no digest anywhere, and no store of its own', () => {
    const folder = path.join(env.USERPROFILE!, 'billing');
    fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
    const globalRoot = path.join(tmp, 'global');
    initStore(globalRoot);
    const transcript = claudeTranscript('g1', { cwd: folder, prompt: `${RULE}; uploads keep timing out overnight.` });
    expect(hippo(workerArgs('G1', transcript), undefined, folder).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('digest: skip: this folder has no store of its own');
    expect(hippo(codexRollout(folder), undefined, folder).status).toBe(0);
    expect(fs.readFileSync(log, 'utf8')).toContain('digest: skip: this folder has no store of its own');

    const global = loadAllEntries(globalRoot);
    expect(global.some((e) => e.content.includes(RULE) && e.origin_project === 'billing')).toBe(true);
    expect(loadLatestHandoff(globalRoot, 'default', 'G1')).not.toBeNull();
    expect(global.filter(isSessionDigestRow)).toEqual([]);
    expect(digests()).toEqual([]);
    expect(fs.existsSync(path.join(folder, '.hippo'))).toBe(false);
  });
});

describe('context prints the handoff or the digest, never both', SLOW, () => {
  const context = (format: 'additional-context' | 'json'): string => {
    const result = hippo(['context', '--pinned-only', '--include-recent', '5', '--format', format], '');
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const memoryIds = (): string[] => JSON.parse(context('json')).memories.map((m: { id: string }) => m.id);

  it('hides the digest behind its own session handoff, even when it is the only memory', () => {
    claudeWorker('S1', claudeTranscript('s1'));
    expect(loadAllEntries(path.join(repo, '.hippo')).map((e) => e.id)).toEqual([sessionDigestId('default', 'S1')]);
    const text = context('additional-context');
    expect(text).toContain('## Session Handoff');
    expect(text).not.toContain('Changed:');
    const json = JSON.parse(context('json'));
    expect(json.sessionHandoff.sessionId).toBe('S1');
    expect(json.memories.map((m: { id: string }) => m.id)).not.toContain(sessionDigestId('default', 'S1'));
  });

  it("shows an earlier session's digest under a later session's handoff", () => {
    claudeWorker('S1', claudeTranscript('s1'));
    claudeWorker('S2', claudeTranscript('s2', { reply: OTHER_REPLY, edited: 'queue.ts' }));
    expect(JSON.parse(context('json')).sessionHandoff.sessionId).toBe('S2');
    expect(memoryIds()).toContain(sessionDigestId('default', 'S1'));
    expect(memoryIds()).not.toContain(sessionDigestId('default', 'S2'));
  });

  it('shows the digest in place of a handoff the budget drops, and never both at any budget', () => {
    claudeWorker('S1', claudeTranscript('s1'));
    const seen = [40, 60, 80, 100, 150, 200, 1500].map((budget) => {
      const result = hippo(['context', '--pinned-only', '--include-recent', '5', '--format', 'json', '--budget', String(budget)], '');
      expect(result.status).toBe(0);
      // Nothing fits the smallest budgets, and then context prints nothing at all.
      const json = result.stdout.trim() ? JSON.parse(result.stdout) : { memories: [] };
      const digest = json.memories.some((m: { id: string }) => m.id === sessionDigestId('default', 'S1'));
      return { budget, handoff: json.sessionHandoff?.sessionId === 'S1', digest };
    });
    expect(seen.filter((s) => s.handoff && s.digest)).toEqual([]);
    expect(seen.some((s) => !s.handoff && s.digest)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ handoff: true, digest: false });
  });

  it('shows the digest when its session handoff is scope-hidden', () => {
    claudeWorker('S1', claudeTranscript('s1'));
    saveSessionHandoff(path.join(repo, '.hippo'), 'default', {
      version: 1, sessionId: 'S1', summary: 'private thread', scope: 'slack:private:C123', evidence: { derivedFrom: 'transcript' },
    });
    expect(JSON.parse(context('json')).sessionHandoff).toBeNull();
    expect(memoryIds()).toContain(sessionDigestId('default', 'S1'));
  });
});
