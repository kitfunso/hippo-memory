import { describe, it, expect } from 'vitest';
import { chatLineTurn } from '../../src/surface/capture/chat-line-transcript.js';
import { collectSessionTurns } from '../../src/surface/capture/transcript.js';

const jsonl = (...rows: readonly unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n');

const CLAUDE_CODE = {
  type: 'user',
  message: { role: 'user', content: 'rotate the signing keys' },
};
const CODEX = {
  type: 'response_item',
  payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Keys rotated.' }] },
};
const COPILOT = { type: 'user.message', data: { content: 'check the retry budget' } };

describe('a {role, content} chat line', () => {
  it('gives one turn per user or assistant line, in file order, with the text trimmed', () => {
    const turns = collectSessionTurns(
      jsonl(
        { role: 'user', content: 'which store holds the deploy notes?' },
        { role: 'assistant', content: 'The global store holds them.' },
        { role: 'user', content: '  thanks  ' },
      ),
    );
    expect(turns).toEqual([
      { role: 'user', text: 'which store holds the deploy notes?' },
      { role: 'assistant', text: 'The global store holds them.' },
      { role: 'user', text: 'thanks' },
    ]);
  });

  it('is still one turn with extra keys beside the role and content', () => {
    const line = { role: 'user', content: 'hello', ts: 1700000000, meta: { host: 'hermes' } };
    expect(collectSessionTurns(jsonl(line))).toEqual([{ role: 'user', text: 'hello' }]);
  });

  it('gives no turn for blank, non-string or missing content', () => {
    for (const content of [
      '',
      '   \n',
      5,
      null,
      true,
      ['hello'],
      [{ type: 'text', text: 'hello' }],
      { text: 'hello' },
    ]) {
      expect(chatLineTurn({ role: 'user', content })).toBeNull();
    }
    expect(chatLineTurn({ role: 'assistant' })).toBeNull();
  });

  it('gives no turn for any role but user and assistant', () => {
    for (const role of ['system', 'tool', 'developer', 'User', ' user', '', 7, null]) {
      expect(chatLineTurn({ role, content: 'hello' })).toBeNull();
    }
    expect(chatLineTurn({ content: 'hello' })).toBeNull();
  });

  it('gives no turn for a torn line or a line that is not an object', () => {
    expect(collectSessionTurns('{"role":"user","content":"a torn li')).toEqual([]);
    expect(collectSessionTurns(jsonl('hello', 42, null, ['user', 'hello'], true))).toEqual([]);
  });

  it('belongs to the lines with no type: a line with a type reads by its type alone', () => {
    expect(chatLineTurn({ type: 'user', role: 'user', content: 'hello' })).toBeNull();
    expect(collectSessionTurns(jsonl({ type: 'note', role: 'user', content: 'hello' }))).toEqual([]);
  });
});

describe('a transcript that mixes chat lines with typed lines', () => {
  const TYPED = [
    { role: 'user', text: 'rotate the signing keys' },
    { role: 'assistant', text: 'Keys rotated.' },
    { role: 'user', text: 'check the retry budget' },
  ];

  it('gives each Claude Code, Codex and Copilot line the turn it gave before chat lines were read', () => {
    expect(collectSessionTurns(jsonl(CLAUDE_CODE, CODEX, COPILOT))).toEqual(TYPED);
  });

  it('keeps those turns, and adds the chat lines between them in order', () => {
    const mixed = jsonl(
      { role: 'user', content: 'start of the chat' },
      CLAUDE_CODE,
      CODEX,
      { role: 'assistant', content: 'a chat reply' },
      COPILOT,
    );
    expect(collectSessionTurns(mixed)).toEqual([
      { role: 'user', text: 'start of the chat' },
      TYPED[0],
      TYPED[1],
      { role: 'assistant', text: 'a chat reply' },
      TYPED[2],
    ]);
  });

  it('calls the visitor for typed lines only', () => {
    const seen: unknown[] = [];
    collectSessionTurns(jsonl({ role: 'user', content: 'chat' }, CLAUDE_CODE), (record) => seen.push(record));
    expect(seen).toEqual([CLAUDE_CODE]);
  });
});
