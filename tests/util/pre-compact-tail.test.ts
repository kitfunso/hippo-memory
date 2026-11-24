import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { truncateCodePointSafe } from '../../src/base/util/code-point-cut.js';
import { readTranscriptTail } from '../../src/infra/transcript-tail.js';

describe('readTranscriptTail boundary behavior (capBytes)', () => {
  let dir: string;
  let filePath: string;
  const lineA = 'A'.repeat(9) + '\n';
  const lineB = 'B'.repeat(9) + '\n';
  const lineC = 'C'.repeat(9) + '\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-tail-unit-'));
    filePath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(filePath, lineA + lineB + lineC, 'utf8');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('(a) seek landing mid-line drops the partial first line', () => {
    const tail = readTranscriptTail(filePath, 25);
    expect(tail).toBe(lineB + lineC);
    expect(tail.startsWith('A')).toBe(false);
  });

  it('(b) seek landing exactly on a newline boundary keeps the following complete line', () => {
    const tail = readTranscriptTail(filePath, 20);
    expect(tail).toBe(lineB + lineC);
  });

  it('(c) file smaller than cap returns whole content', () => {
    const tail = readTranscriptTail(filePath, 1000);
    expect(tail).toBe(lineA + lineB + lineC);
  });

  it('capBytes exactly equal to file size returns whole content (start=0)', () => {
    const tail = readTranscriptTail(filePath, 30);
    expect(tail).toBe(lineA + lineB + lineC);
  });

  it('an empty transcript reads as no text', () => {
    fs.writeFileSync(filePath, '');
    expect(readTranscriptTail(filePath, 15)).toBe('');
  });

  it('a missing transcript throws the system error, for the caller to log', () => {
    expect(() => readTranscriptTail(path.join(dir, 'gone.jsonl'), 15)).toThrow(/ENOENT/);
  });
});

describe('truncateCodePointSafe', () => {
  it('backs off one unit when the cut point lands on a high surrogate', () => {
    const grinningFace = '😀';
    const text = 'A'.repeat(9) + grinningFace;
    const truncated = truncateCodePointSafe(text, 10);
    expect(truncated).toBe('A'.repeat(9));
    expect(truncated.length).toBe(9);
    const lastCode = truncated.charCodeAt(truncated.length - 1);
    expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
  });

  it('cuts exactly at maxChars when the boundary does not split a pair', () => {
    const text = 'A'.repeat(20);
    expect(truncateCodePointSafe(text, 10)).toBe('A'.repeat(10));
  });

  it('returns the text unchanged when it is already within the cap', () => {
    const text = 'short';
    expect(truncateCodePointSafe(text, 100)).toBe('short');
  });
});
