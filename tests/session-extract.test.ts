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
