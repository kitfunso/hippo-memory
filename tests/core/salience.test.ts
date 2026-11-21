import { describe, it, expect } from 'vitest';
import type { MemoryEntry, EmotionalValence } from '../../src/base/memory/entry.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import { computeSalience } from '../../src/base/memory/salience.js';
import { identityText } from '../../src/base/util/same-text.js';

function mem(
  content: string,
  opts: { tags?: string[]; emotionalValence?: EmotionalValence; leadIn?: string } = {},
): MemoryEntry {
  const entry = createMemory(content, { tags: opts.tags ?? [], leadIn: opts.leadIn });
  if (opts.emotionalValence) entry.emotionalValence = opts.emotionalValence;
  return entry;
}

describe('computeSalience', () => {
  it('skips content shorter than minContentLength', () => {
    const result = computeSalience('hi', [], []);
    expect(result.decision).toBe('skip');
    expect(result.reason).toBe('content_too_short');
  });

  it('stores pinned content regardless', () => {
    const result = computeSalience('hi', ['pinned'], []);
    expect(result.decision).toBe('store');
    expect(result.score).toBe(1.0);
  });

  it('stores novel content', () => {
    const result = computeSalience('This is a completely novel piece of information about database migrations', [], []);
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('novel');
  });

  it('skips duplicate content', () => {
    const existing = [mem('Database migration failed with timeout error on production')];
    const result = computeSalience('Database migration failed with timeout error on production', [], existing);
    expect(result.decision).toBe('skip');
    expect(result.reason).toContain('duplicate');
  });

  it('stores error content despite overlap', () => {
    const existing = [mem('Database migration failed with timeout error')];
    const result = computeSalience('Database migration failed with timeout error', ['error'], existing);
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('error_despite_overlap');
  });

  it('weakens repeat errors when too many recent', () => {
    const recent = Array.from({ length: 5 }, (_, i) =>
      mem(`Error ${i}: connection timeout on database`, {
        tags: ['error'],
        emotionalValence: 'negative',
      }),
    );
    const result = computeSalience('Error 5: connection timeout on database', ['error'], recent);
    expect(result.decision).toBe('start_weak');
    expect(result.score).toBeLessThan(0.5);
  });

  it('stores novel errors at high score', () => {
    const result = computeSalience('Never seen before: quantum decoherence in memory subsystem', ['error'], []);
    expect(result.decision).toBe('store');
    expect(result.reason).toBe('error_novel');
    expect(result.score).toBe(0.9);
  });

  it('boosts score for structured tags', () => {
    const plain = computeSalience('Some useful information about the project', [], []);
    const structured = computeSalience('Some useful information about the project', ['topic:architecture'], []);
    expect(structured.score).toBeGreaterThan(plain.score);
  });

  it('boosts score for longer content', () => {
    const short = computeSalience('Short but valid content here', [], []);
    const long = computeSalience(
      'This is a much longer piece of content that contains significantly more information about the topic at hand, including details about implementation, architecture decisions, and tradeoffs that were considered during the design phase of the system under discussion',
      [],
      [],
    );
    expect(long.score).toBeGreaterThan(short.score);
  });

  it('respects custom overlapThreshold', () => {
    const existing = [mem('The quick brown fox jumps over the lazy dog near the river')];
    const strictResult = computeSalience('The quick brown fox jumps over the lazy dog near the river', [], existing, {
      overlapThreshold: 0.3,
    });
    expect(strictResult.decision).toBe('skip');
  });
});

describe('computeSalience on the identity text of a write with a lead-in', () => {
  const FLIGHT = 'user: Is the flight booked?';
  const JOB = 'user: Did Mel get the job?';
  const window = [mem('Yes, it is booked.', { leadIn: FLIGHT })];

  it('skips the same reply under the same lead-in, spacing apart', () => {
    const text = identityText({ content: 'Yes,  it is booked.\n', leadIn: ` ${FLIGHT} ` });
    expect(computeSalience(text, [], window)).toMatchObject({ decision: 'skip', score: 0.1 });
  });

  it('does not skip the same reply under another lead-in', () => {
    const result = computeSalience(identityText({ content: 'Yes, it is booked.', leadIn: JOB }), [], window);
    expect(result.decision).toBe('store');
  });

  it('does not skip the same reply with no lead-in against a row that has one', () => {
    expect(computeSalience('Yes, it is booked.', [], window).decision).toBe('store');
  });

  it('reads a window row by its content and lead-in together, and a short reply is long enough with one', () => {
    expect(computeSalience('Yes.', [], []).reason).toBe('content_too_short');
    expect(computeSalience(identityText({ content: 'Yes.', leadIn: FLIGHT }), [], []).reason).toBe('novel');
    const repeat = [mem('Yes.', { leadIn: FLIGHT, tags: ['error'], emotionalValence: 'negative' })];
    const text = identityText({ content: 'Booked', leadIn: FLIGHT });
    expect(computeSalience(text, ['error'], repeat).reason).toBe('error_despite_overlap');
  });
});
