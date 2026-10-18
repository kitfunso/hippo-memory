// The task and next step come from the last human user turn and the last main-agent assistant text, each skipping the lines that are neither.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { transcriptWorkingState } from '../../src/capture/working-state.js';

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: string;
}

interface Flags {
  isMeta?: boolean;
  isSidechain?: boolean;
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-working-state-turns-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function derive(lines: readonly string[]) {
  const file = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return transcriptWorkingState(file, () => {});
}

const user = (content: string | Block[], flags: Flags = {}) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, ...flags });
const assistant = (content: Block[], flags: Flags = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content }, ...flags });
const text = (t: string): Block => ({ type: 'text', text: t });

describe('transcriptWorkingState turn selection', () => {
  it('takes the newest human task and the newest assistant text block, skipping every line that is neither', () => {
    const state = derive([
      'ngth":5}}',
      user('an older task'),
      assistant([text('an older reply')]),
      user('the real task'),
      assistant([text('  the real next step  '), { type: 'tool_use', id: 't1', name: 'Bash' }]),
      user([{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      assistant([text('sub-agent text')], { isSidechain: true }),
      user('compact summary', { isMeta: true }),
      assistant([{ type: 'thinking', thinking: 'hm' }]),
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ unrelated: true }),
    ]);
    expect(state?.task).toBe('the real task');
    expect(state?.next_step).toBe('the real next step');
  });

  it('gives an empty task when no human turn exists and an empty next step when no assistant text exists', () => {
    expect(derive([assistant([text('only the agent spoke')])])).toMatchObject({
      task: '',
      next_step: 'only the agent spoke',
    });
    expect(derive([user('only the human spoke')])).toMatchObject({ task: 'only the human spoke', next_step: '' });
  });
});
