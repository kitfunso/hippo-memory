import { describe, expect, it } from 'vitest';

import { extractSessionMemories, type SessionTurn } from '../src/session-extract.js';

function turn(role: SessionTurn['role'], text: string): SessionTurn {
  return { role, text };
}

describe('extractSessionMemories', () => {
  it('keeps a rule sentence whole, with its subject and its reason', () => {
    const items = extractSessionMemories([
      turn('user', 'The deploy script must never run migrations, because the replica lags.'),
    ]);
    expect(items).toEqual([
      {
        content: 'The deploy script must never run migrations, because the replica lags.',
        category: 'rule',
        tags: ['rule', 'captured'],
      },
    ]);
  });

  it('drops a subject-less sentence that leads with a deictic pronoun', () => {
    const items = extractSessionMemories([
      turn('user', 'It must never run migrations on the replica during business hours.'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops "The fix is ..." when it names no component', () => {
    const items = extractSessionMemories([
      turn('user', 'The fix is to raise the timeout to thirty seconds, because runners are slow.'),
    ]);
    expect(items).toEqual([]);
  });

  it('keeps "The fix is ..." when it names a code token', () => {
    const items = extractSessionMemories([
      turn('user', 'The fix is to raise the timeout in upload.spec.ts to thirty seconds, because runners are slow.'),
    ]);
    expect(items).toHaveLength(1);
  });

  it('drops a sentence that points back with "this" mid-sentence', () => {
    const items = extractSessionMemories([
      turn('user', 'Reinstalling the CLI globally wipes this silently, because the installer never keeps old config.'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops two sentences glued without a space', () => {
    const items = extractSessionMemories([
      turn('user', 'The billing service must never retry payments without a key.Refunds go through the ledger, because audits need it.'),
    ]);
    expect(items).toEqual([]);
  });

  it('prose slashes, plurals and "iPhone" do not count as naming a component', () => {
    const items = extractSessionMemories([
      turn('user', 'The fix is to use read/write locks, because readers never block each other.'),
      turn('user', 'The issues were caused by the iPhone build, because it always strips the cache.'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops an assistant status line with no "I"', () => {
    const items = extractSessionMemories([
      turn('assistant', 'Added a guard so the deploy script must never run migrations, because the replica lags.'),
    ]);
    expect(items).toEqual([]);
  });

  it('keeps an assistant sentence that opens with an adjectival participle', () => {
    const items = extractSessionMemories([
      turn('assistant', 'Cached embeddings must never be reused across models, because the vector sizes differ.'),
    ]);
    expect(items).toHaveLength(1);
  });

  it('drops a markdown table row even when it contains a cue word', () => {
    const items = extractSessionMemories([
      turn('user', '| never crawled | 200 | some other filler text goes here today |'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops a fenced code line even when it contains a cue word', () => {
    const items = extractSessionMemories([
      turn('user', '```\nnever bundle in production because it breaks silently every time\n```'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops an assistant sentence written in first person', () => {
    const items = extractSessionMemories([
      turn('assistant', 'I decided to switch to the new logging library because it is faster.'),
    ]);
    expect(items).toEqual([]);
  });

  it('drops a question', () => {
    const items = extractSessionMemories([
      turn('user', 'Should we always deploy on Fridays given the incident history lately?'),
    ]);
    expect(items).toEqual([]);
  });

  it('joins a trailing "Because ..." sentence onto its lead sentence', () => {
    const items = extractSessionMemories([
      turn('user', 'The team decided to switch to the new queue library entirely. Because the old one dropped messages under load.'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe(
      'The team decided to switch to the new queue library entirely. Because the old one dropped messages under load.'
    );
    expect(items[0].category).toBe('decision');
  });

  it('caps a session with ten qualifying sentences at 3', () => {
    const ord = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const text = ord.map((w) => `Rule number ${w} says we must never skip retries during nightly batch runs.`).join(' ');
    const items = extractSessionMemories([turn('user', text)]);
    expect(items).toHaveLength(3);
  });

  it('writes nothing for chit-chat', () => {
    const items = extractSessionMemories([
      turn('user', 'Thanks so much for your help today, it was really great chatting about the weather.'),
    ]);
    expect(items).toEqual([]);
  });

  it('every item has category plus a [category, captured] tag pair', () => {
    const items = extractSessionMemories([
      turn('user', 'The style guide says to prefer the smaller client library instead of the generated SDK.'),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      content: items[0].content,
      category: items[0].category,
      tags: [items[0].category, 'captured'],
    });
  });
});
