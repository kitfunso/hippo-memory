import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { END_CHECK_LEAD } from '../../src/api/end-check.js';
import { scanForEndCheck, scanForValidity } from '../../src/surface/capture/end-check-scan.js';
import { collectSessionTurns } from '../../src/surface/capture/transcript.js';

const SESSION = '0d0a77e4-2997-4106-b10f-21af152d5eca';
const at = (s: number): string => new Date(Date.UTC(2026, 10, 24, 20, 0, s)).toISOString();
const jsonl = <T>(rows: readonly T[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const prompt = (text: string, s: number, entrypoint = 'cli') => ({
  type: 'user',
  isSidechain: false,
  entrypoint,
  timestamp: at(s),
  message: { role: 'user', content: text },
});
const said = (text: string, s: number) => ({
  type: 'assistant',
  isSidechain: false,
  timestamp: at(s),
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const use = <T>(id: string, name: string, input: T, s: number) => ({
  type: 'assistant',
  timestamp: at(s),
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, s: number, isError = false) => ({
  type: 'user',
  timestamp: at(s),
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok', is_error: isError }] },
});
const asSidechain = <T>(row: T) => ({ ...row, isSidechain: true, agentId: 'a1' });

function stopCheckRow(text: string, s: number) {
  return {
    parentUuid: '8660b7f7-ba6e-48de-a4ef-2a36d77726ff',
    isSidechain: false,
    attachment: {
      type: 'hook_additional_context',
      content: [text],
      hookName: 'Stop',
      toolUseID: 'bb9df7f7-6293-4bca-abb5-2972bd038084',
      hookEvent: 'Stop',
    },
    type: 'attachment',
    uuid: '4c987909-51ca-4c09-aeb2-a562339dfcbb',
    timestamp: at(s),
    rendered: [{ content: `<system-reminder>\nStop hook additional context: ${text}\n</system-reminder>` }],
    renderedRole: 'system',
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd: '/work/repo',
    sessionId: SESSION,
    version: '2.1.326',
    gitBranch: 'HEAD',
  };
}

let dir: string;
let main: string;

function writeMain<T>(rows: readonly T[]): void {
  fs.writeFileSync(main, jsonl(rows));
}

function writeSubagent<T>(relative: string, rows: readonly T[]): void {
  const file = path.join(dir, SESSION, 'subagents', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(rows));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'end-check-scan-'));
  main = path.join(dir, `${SESSION}.jsonl`);
});

describe('scanForEndCheck', () => {
  it('reads an earlier Stop listing from its attachment row, which is never a person turn', async () => {
    const listing = `${END_CHECK_LEAD}\nDo each one that applies to your change.\n\n1. Run \`npm test\``;
    const rows = [
      prompt('fix the parser', 0),
      use('e1', 'Edit', { file_path: 'C:\\Repo\\src\\Parse.ts' }, 1),
      result('e1', 2),
      said('Fixed.', 3),
      stopCheckRow(listing, 4),
      stopCheckRow('Some other Stop hook text.', 5),
      said('Ran it.', 6),
    ];
    writeMain(rows);

    const scan = await scanForEndCheck(main, 'Ran it.');

    expect(scan).toEqual({
      editsSincePrompt: ['c:/repo/src/parse.ts'],
      editedSincePrompt: true,
      commands: [],
      earlierChecks: listing,
    });
    const users = collectSessionTurns(jsonl(rows)).filter((t) => t.role === 'user');
    expect(users.map((t) => t.text)).toEqual(['fix the parser']);
  });

  it('adds the commands and edits of sub-agent transcripts, workflow agents included', async () => {
    writeMain([
      prompt('ship it', 0),
      use('t1', 'Task', { prompt: 'run checks' }, 1),
      result('t1', 9),
      said('Done.', 10),
    ]);
    writeSubagent('agent-a1.jsonl', [
      asSidechain(prompt('run checks', 2)),
      asSidechain(use('b1', 'Bash', { command: 'npm test' }, 3)),
      asSidechain(result('b1', 4)),
      asSidechain(use('w1', 'Write', { file_path: '/repo/A.py' }, 5)),
      asSidechain(result('w1', 6)),
    ]);
    writeSubagent('workflows/wf_1/agent-b2.jsonl', [
      asSidechain(use('b2', 'Bash', { command: 'ruff check .' }, 7)),
      asSidechain(result('b2', 8)),
    ]);
    writeSubagent('workflows/wf_1/journal.jsonl', [use('b3', 'Bash', { command: 'make lint' }, 7), result('b3', 8)]);

    const scan = await scanForEndCheck(main, 'Done.');

    expect(scan?.commands).toEqual(['npm test', 'ruff check .']);
    expect(scan?.editsSincePrompt).toEqual(['/repo/a.py']);
  });

  it('gives null when the transcript never catches up with the final message, or is missing', async () => {
    writeMain([prompt('go', 0), said('Working.', 1)]);

    expect(await scanForEndCheck(main, 'All done.')).toBeNull();
    expect(await scanForEndCheck(path.join(dir, 'gone.jsonl'), null)).toBeNull();
  });

  it('counts edits only after the last typed prompt, and commands over the whole session', async () => {
    writeMain([
      prompt('first', 0),
      use('e1', 'Edit', { file_path: '/repo/a.ts' }, 1),
      result('e1', 2),
      use('b1', 'Bash', { command: 'cd /repo\nNPM run "lint"' }, 3),
      result('b1', 4),
      said('ok', 5),
      prompt('second', 6),
      said('Nothing to change.', 7),
    ]);
    writeSubagent('agent-a1.jsonl', [asSidechain(use('w1', 'Write', { file_path: '/repo/b.ts' }, 3)), result('w1', 4)]);

    const scan = await scanForEndCheck(main, 'Nothing to change.');

    expect(scan).toEqual({
      editsSincePrompt: [],
      editedSincePrompt: false,
      commands: ['cd /repo\nNPM run "lint"'],
      earlierChecks: '',
    });
  });

  it('takes the written files of a Bash write after the prompt as edits', async () => {
    const command = `sed -i 's/a/b/' Src/App.py && echo x > out.txt`;
    writeMain([prompt('go', 0), use('b1', 'Bash', { command }, 1), result('b1', 2), said('ok', 3)]);

    const scan = await scanForEndCheck(main, 'ok');

    expect([scan?.editsSincePrompt, scan?.editedSincePrompt]).toEqual([['src/app.py', 'out.txt'], true]);
  });

  it('marks a Bash write with no file name as an edit with no path', async () => {
    writeMain([prompt('go', 0), use('b1', 'Bash', { command: 'rm -rf build' }, 1), result('b1', 2), said('ok', 3)]);

    const scan = await scanForEndCheck(main, 'ok');

    expect([scan?.editsSincePrompt, scan?.editedSincePrompt]).toEqual([[], true]);
  });

  it('reads a scripted prompt as the boundary only when scripted turns are the person', async () => {
    writeMain([
      prompt('teach', 0, 'sdk-cli'),
      use('e1', 'Edit', { file_path: '/repo/a.ts' }, 1),
      result('e1', 2),
      prompt('task', 3, 'sdk-cli'),
      said('ok', 4),
    ]);

    expect((await scanForEndCheck(main, 'ok'))?.editsSincePrompt).toEqual(['/repo/a.ts']);
    expect((await scanForEndCheck(main, 'ok', { scriptedIsHuman: true }))?.editsSincePrompt).toEqual([]);
  });

  it('ignores a call whose result is an error, or that has no result', async () => {
    writeMain([
      prompt('go', 0),
      use('b1', 'Bash', { command: 'npm test' }, 1),
      result('b1', 2, true),
      use('e1', 'Edit', { file_path: '/repo/a.ts' }, 3),
      result('e1', 4, true),
      use('w1', 'Write', { file_path: '/repo/b.ts' }, 5),
      said('ok', 6),
    ]);

    expect(await scanForEndCheck(main, 'ok')).toEqual({
      editsSincePrompt: [],
      editedSincePrompt: false,
      commands: [],
      earlierChecks: '',
    });
  });
});

describe('scanForValidity', () => {
  it('keeps each typed prompt and gives the commands that landed before one, in time order', () => {
    const correction = 'Every pytest call takes -m "not notebooks".';
    writeMain([
      prompt('fix the reader', 0),
      use('b1', 'Bash', { command: 'pytest -m "not notebooks"' }, 1),
      result('b1', 2),
      use('t1', 'Task', { prompt: 'run lint' }, 3),
      result('t1', 6),
      use('b2', 'Bash', { command: 'pytest tests/test_io.py' }, 7),
      result('b2', 8),
      use('b3', 'Bash', { command: 'npm test' }, 9),
      prompt(correction, 10),
      use('b4', 'Bash', { command: 'pytest -m "not notebooks" tests/test_io.py' }, 11),
      result('b4', 12),
      said('ok', 13),
    ]);
    writeSubagent('agent-a1.jsonl', [
      asSidechain(use('s1', 'Bash', { command: 'ruff check .' }, 4)),
      asSidechain(result('s1', 5)),
      asSidechain(use('s2', 'Bash', { command: 'make lint' }, 11)),
      asSidechain(result('s2', 12)),
    ]);

    const scan = scanForValidity(main);

    expect(scan.prompts.map(({ text, at: time }) => [text, time])).toEqual([
      ['fix the reader', Date.parse(at(0))],
      [correction, Date.parse(at(10))],
    ]);
    expect(scan.prompts[0].seq).toBeLessThan(scan.prompts[1].seq);
    expect(scan.before(scan.prompts[0]).commands).toEqual([]);
    expect(scan.before(scan.prompts[1]).commands).toEqual([
      'pytest -m "not notebooks"',
      'ruff check .',
      'pytest tests/test_io.py',
    ]);
  });

  it('reads scripted prompts only when scripted turns are the person', () => {
    writeMain([prompt('teach', 0, 'sdk-cli'), said('ok', 1), prompt('fix it', 2, 'sdk-cli'), said('done', 3)]);

    expect(scanForValidity(main).prompts).toEqual([]);
    expect(scanForValidity(main, { scriptedIsHuman: true }).prompts.map((p) => p.text)).toEqual(['teach', 'fix it']);
  });
});
