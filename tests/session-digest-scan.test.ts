// Reading a Claude Code transcript or a Codex rollout for the digest: turns, closing message, edits that landed.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSessionScan, scanSessionTranscript } from '../src/session-digest.js';

const CWD = '/work/repo';
const jsonl = <T,>(records: readonly T[]): string => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

interface LineFlags { isSidechain?: boolean; isMeta?: boolean }
const userSays = <T,>(content: string | readonly T[], extra: LineFlags = {}) => ({ type: 'user', cwd: CWD, ...extra, message: { role: 'user', content } });
const assistantSays = <T,>(content: readonly T[], extra: LineFlags = {}) => ({ type: 'assistant', cwd: CWD, ...extra, message: { role: 'assistant', content } });
const text = (t: string) => ({ type: 'text', text: t });
const toolUse = <T,>(id: string, name: string, input: T) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string, isError = false) => userSays([{ type: 'tool_result', tool_use_id: id, content: 'done', is_error: isError }]);

describe('Claude Code transcripts', () => {
  it('reads the closing message from the last main-thread assistant text', () => {
    const scan = scanSessionTranscript(jsonl([
      userSays('fix the upload retry'),
      assistantSays([text('Looking now.')]),
      assistantSays([text('Fixed `retry()` because tokens expire.'), toolUse('t9', 'Read', { file_path: 'a.ts' })]),
      assistantSays([text('Sub-agent reply.')], { isSidechain: true }),
      assistantSays([text('Meta note.')], { isMeta: true }),
    ]));
    expect(scan.finalText).toBe('Fixed `retry()` because tokens expire.');
    expect(scan.cwd).toBe(CWD);
    expect(scan.turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['fix the upload retry']);
  });

  it.each([
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'Claude AI usage limit reached|1790000000',
    'Prompt is too long',
  ])("skips Claude Code's own notice as the closing message: %s", (notice) => {
    const scan = scanSessionTranscript(jsonl([
      userSays('fix the upload retry'),
      assistantSays([text('Fixed `retry()` because tokens expire.')]),
      { type: 'assistant', cwd: CWD, message: { role: 'assistant', model: '<synthetic>', content: [text(notice)] } },
    ]));
    expect(scan.finalText).toBe('Fixed `retry()` because tokens expire.');
  });

  it('counts Edit, Write, MultiEdit and NotebookEdit only once their results come back clean', () => {
    const scan = scanSessionTranscript(jsonl([
      userSays('go'),
      assistantSays([toolUse('e1', 'Edit', { file_path: `${CWD}/src/a.ts` })]),
      toolResult('e1'),
      assistantSays([toolUse('w1', 'Write', { file_path: 'src/b.ts' })]),
      toolResult('w1'),
      assistantSays([toolUse('m1', 'MultiEdit', { file_path: `${CWD}/src/c.ts` })]),
      toolResult('m1'),
      assistantSays([toolUse('n1', 'NotebookEdit', { notebook_path: `${CWD}/nb.ipynb` })]),
      toolResult('n1'),
      assistantSays([toolUse('x1', 'Edit', { file_path: `${CWD}/src/failed.ts` })]),
      toolResult('x1', true),
      assistantSays([toolUse('u1', 'Write', { file_path: `${CWD}/src/unanswered.ts` })]),
      assistantSays([toolUse('s1', 'Edit', { file_path: `${CWD}/src/side.ts` })], { isSidechain: true }),
      toolResult('s1'),
    ]));
    expect(scan.edits).toEqual([
      { filePath: `${CWD}/src/a.ts`, base: CWD },
      { filePath: 'src/b.ts', base: CWD },
      { filePath: `${CWD}/src/c.ts`, base: CWD },
      { filePath: `${CWD}/nb.ipynb`, base: CWD },
      { filePath: `${CWD}/src/side.ts`, base: CWD },
    ]);
  });

  it('does not count tool results or meta lines as prompts', () => {
    const scan = scanSessionTranscript(jsonl([
      userSays('the real request'),
      userSays('injected by a hook', { isMeta: true }),
      toolResult('e1'),
    ]));
    expect(scan.turns.filter((t) => t.role === 'user').map((t) => t.text)).toEqual(['the real request']);
  });
});

const item = <T,>(payload: T) => ({ type: 'response_item', payload });
const codexUser = (t: string) => item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] });
// JSON.stringify drops an undefined phase, which is how an unphased message looks on disk.
const codexSays = (t: string, phase?: string) =>
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }], phase });
const patch = (...headers: string[]): string => ['*** Begin Patch', ...headers, '*** End Patch'].join('\n');
const OK = 'Success. Updated the following files:\nM src/a.ts\n';

describe('Codex rollouts', () => {
  it('prefers the final_answer message over later commentary, then falls back to an unphased message', () => {
    const phased = scanSessionTranscript(jsonl([
      { type: 'session_meta', payload: { id: 's', cwd: CWD } },
      codexUser('fix it'),
      codexSays('Plain reply.'),
      codexSays('The fix is in.', 'final_answer'),
      codexSays('Checking one more thing.', 'commentary'),
    ]));
    expect(phased.finalText).toBe('The fix is in.');
    expect(phased.cwd).toBe(CWD);

    const unphased = scanSessionTranscript(jsonl([codexUser('fix it'), codexSays('Plain reply.'), codexSays('Thinking.', 'commentary')]));
    expect(unphased.finalText).toBe('Plain reply.');
  });

  it('counts a patch only when its output reports success', () => {
    const scan = scanSessionTranscript(jsonl([
      { type: 'turn_context', payload: { cwd: CWD } },
      item({ type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: patch('*** Add File: src/new.ts', '+x') }),
      item({ type: 'custom_tool_call_output', call_id: 'c1', output: OK }),
      item({ type: 'function_call', call_id: 'f1', name: 'apply_patch', arguments: JSON.stringify({ input: patch('*** Update File: src/old.ts', '*** Move to: src/moved.ts') }) }),
      item({ type: 'function_call_output', call_id: 'f1', output: [{ type: 'input_text', text: OK }] }),
      item({ type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: patch('*** Delete File: src/failed.ts') }),
      item({ type: 'custom_tool_call_output', call_id: 'c2', output: 'error: patch did not apply' }),
      item({ type: 'custom_tool_call', call_id: 'c3', name: 'apply_patch', input: patch('*** Delete File: src/unanswered.ts') }),
      item({ type: 'custom_tool_call', call_id: 'c4', name: 'apply_patch', input: patch('*** Delete File: src/evented.ts') }),
      { type: 'event_msg', payload: { type: 'patch_apply_end', call_id: 'c4', success: true } },
    ]));
    expect(scan.edits.map((e) => e.filePath)).toEqual(['src/new.ts', 'src/old.ts', 'src/moved.ts', 'src/evented.ts']);
  });

  it('reads heredoc patches from shell calls against the cwd in effect at the call', () => {
    const body = patch('*** Add File: lib.ts', '+x');
    const scan = scanSessionTranscript(jsonl([
      { type: 'turn_context', payload: { cwd: CWD } },
      item({ type: 'function_call', call_id: 'h1', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', `cd pkg && apply_patch <<'EOF'\n${body}\nEOF`] }) }),
      item({ type: 'function_call_output', call_id: 'h1', output: OK }),
      { type: 'turn_context', payload: { cwd: `${CWD}/sub` } },
      item({ type: 'function_call', call_id: 'h2', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', body], workdir: 'tools' }) }),
      item({ type: 'function_call_output', call_id: 'h2', output: OK }),
      item({ type: 'local_shell_call', call_id: 'h3', action: { type: 'exec', command: ['bash', '-lc', `apply_patch <<'EOF'\n${body}\nEOF`], working_directory: '/other' } }),
      item({ type: 'function_call_output', call_id: 'h3', output: OK }),
    ]));
    expect(scan.cwd).toBe(CWD);
    expect(scan.edits.map((e) => [e.filePath, e.base?.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')])).toEqual([
      ['lib.ts', `${CWD}/pkg`],
      ['lib.ts', `${CWD}/sub/tools`],
      ['lib.ts', '/other'],
    ]);
  });
});

describe('the transcript on disk', () => {
  it('is read and scanned, and a missing one gives null with the reason logged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-digest-scan-'));
    try {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, jsonl([userSays('fix the upload retry'), assistantSays([text('Fixed the retry.')])]));
      const logged: string[] = [];
      expect(readSessionScan(file, (m) => logged.push(m))?.finalText).toBe('Fixed the retry.');
      expect(logged).toEqual([]);

      expect(readSessionScan(path.join(dir, 'gone.jsonl'), (m) => logged.push(m))).toBeNull();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatch(/^digest: could not read the transcript: ENOENT/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
