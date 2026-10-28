import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postReply } from '../../src/base/util/thread-reply.js';

const failure = (cause: unknown) => ({ ok: false, why: cause instanceof Error ? cause.message : 'x' });

describe('postReply', () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts the reply and its transfer list once', () => {
    const port = { postMessage: vi.fn() };
    const end = vi.fn();
    const buffer = new ArrayBuffer(1);
    postReply(port, { reply: { ok: true }, transfer: [buffer], failureOf: failure, what: 'reply', end });
    expect(port.postMessage).toHaveBeenCalledExactlyOnceWith({ ok: true }, [buffer]);
    expect(end).not.toHaveBeenCalled();
  });

  it('posts the failure when the reply cannot be copied, without ending the thread', () => {
    const port = {
      postMessage: vi.fn().mockImplementationOnce(() => {
        throw new Error('could not be cloned');
      }),
    };
    const end = vi.fn();
    postReply(port, { reply: { ok: true }, transfer: [], failureOf: failure, what: 'reply', end });
    expect(port.postMessage).toHaveBeenLastCalledWith({ ok: false, why: 'could not be cloned' });
    expect(end).not.toHaveBeenCalled();
  });

  it('ends the thread when the failure cannot be posted either, so the server rejects the caller', () => {
    const port = {
      postMessage: vi.fn(() => {
        throw new Error('port closed');
      }),
    };
    const end = vi.fn();
    postReply(port, { reply: { ok: true }, transfer: [], failureOf: failure, what: 'reply', end });
    expect(end).toHaveBeenCalledOnce();
  });
});
