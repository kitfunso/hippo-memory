import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTranscriptTail, truncateCodePointSafe } from '../src/capture.js';

/**
 * Direct unit tests for readTranscriptTail's positional-read boundary
 * handling (review round X14). No CLI spawn, no store — this is a pure
 * filesystem function, so plain fs fixtures are enough.
 *
 * Fixture layout: three 10-byte lines (9 'X'-ish chars + '\n'), so byte
 * offsets are easy to reason about by hand.
 *   line A: bytes [0, 10)   "AAAAAAAAA\n"
 *   line B: bytes [10, 20)  "BBBBBBBBB\n"
 *   line C: bytes [20, 30)  "CCCCCCCCC\n"
 * Total file size: 30 bytes.
 */
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
    // size=30, capBytes=25 -> start=5, which lands 5 bytes into line A
    // (mid-line, not on a '\n' boundary). The partial remainder of line A
    // must be dropped; only the complete lines B and C survive.
    const tail = readTranscriptTail(filePath, 25);
    expect(tail).toBe(lineB + lineC);
    expect(tail.startsWith('A')).toBe(false);
  });

  it('(b) seek landing exactly on a newline boundary keeps the following complete line', () => {
    // size=30, capBytes=20 -> start=10, which is exactly the byte right
    // after line A's '\n' — i.e. the first byte of line B. The tail
    // already starts on a complete line and must NOT drop it.
    const tail = readTranscriptTail(filePath, 20);
    expect(tail).toBe(lineB + lineC);
  });

  it('(c) file smaller than cap returns whole content', () => {
    // size=30, capBytes=1000 -> start=max(0, 30-1000)=0 -> no line to drop,
    // full file content comes back unchanged.
    const tail = readTranscriptTail(filePath, 1000);
    expect(tail).toBe(lineA + lineB + lineC);
  });

  it('capBytes exactly equal to file size returns whole content (start=0)', () => {
    const tail = readTranscriptTail(filePath, 30);
    expect(tail).toBe(lineA + lineB + lineC);
  });
});

/**
 * X2: truncateCodePointSafe must never split a surrogate pair at the cap.
 */
describe('truncateCodePointSafe (X2)', () => {
  it('backs off one unit when the cut point lands on a high surrogate', () => {
    const grinningFace = '😀'; // U+1F600, a surrogate pair
    const text = 'A'.repeat(9) + grinningFace; // length 11; index 9 is the high surrogate
    const truncated = truncateCodePointSafe(text, 10);
    // A naive slice(0, 10) would keep the lone high surrogate at index 9.
    expect(truncated).toBe('A'.repeat(9));
    expect(truncated.length).toBe(9);
    // No unpaired surrogate left dangling at the end.
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
