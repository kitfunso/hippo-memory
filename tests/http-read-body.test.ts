// readBody's cap and deadline: a slow body fails with its own error class, and the deadline timer never outlives the read.
import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { BodyTimeoutError, BodyTooLargeError, readBody } from '../src/http-util.js';

// SAFETY: readBody only iterates the request's chunks, which any Readable also yields.
const asRequest = (stream: Readable): IncomingMessage => stream as IncomingMessage;

/** One byte every few milliseconds, forever: a client trickling under every size cap. */
function trickle(): Readable {
  let timer: NodeJS.Timeout | undefined;
  return new Readable({
    read() {
      timer = setTimeout(() => this.push('x'), 5);
    },
    // Without this a pending push would still count as a live timer in the next test.
    destroy(err, done) {
      clearTimeout(timer);
      done(err);
    },
  });
}

const liveTimers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('readBody deadline', () => {
  it('fails a never-ending stream with BodyTimeoutError once the deadline passes, and not before', async () => {
    vi.useFakeTimers();
    const body = trickle();
    try {
      const outcome = readBody(asRequest(body), { deadlineMs: 50 }).then(() => 'read', (err: Error) => err);
      await vi.advanceTimersByTimeAsync(49);
      expect(await Promise.race([outcome, 'still reading'])).toBe('still reading');
      await vi.advanceTimersByTimeAsync(1);
      expect(await outcome).toBeInstanceOf(BodyTimeoutError);
    } finally {
      body.destroy();
      vi.useRealTimers();
    }
  });

  it('returns a body that arrives in time and leaves no timer behind', async () => {
    const before = liveTimers();
    expect(await readBody(asRequest(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')])), { deadlineMs: 60_000 })).toBe('{"a":1}');
    expect(liveTimers()).toBe(before);
  });

  it('leaves no timer behind when the read ends over its cap', async () => {
    const before = liveTimers();
    await expect(readBody(asRequest(Readable.from([Buffer.from('abcdef')])), { maxBytes: 4, deadlineMs: 60_000 })).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(liveTimers()).toBe(before);
  });

  it('leaves no timer behind when the stream errors', async () => {
    const before = liveTimers();
    const broken = new Readable({ read() { this.destroy(new Error('socket reset')); } });
    await expect(readBody(asRequest(broken), { deadlineMs: 60_000 })).rejects.toThrow('socket reset');
    expect(liveTimers()).toBe(before);
  });

  it('keeps the cap when no deadline is given', async () => {
    await expect(readBody(asRequest(Readable.from([Buffer.from('abcdef')])), { maxBytes: 4 })).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(await readBody(asRequest(Readable.from([Buffer.from('abcd')])), { maxBytes: 4 })).toBe('abcd');
  });
});
