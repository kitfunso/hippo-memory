// RequestDeadline.onceIdle must run every function registered while store calls are in flight, not only the last one.
import { describe, expect, it } from 'vitest';
import { RequestDeadline } from '../../src/base/util/request-scope.js';

function pendingCall() {
  let settle!: () => void;
  const call = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { call, settle };
}

describe('RequestDeadline.onceIdle', () => {
  it('runs a function at once when no store call is in flight', () => {
    const ran: string[] = [];
    new RequestDeadline(Date.now() + 1000).onceIdle(() => ran.push('now'));
    expect(ran).toEqual(['now']);
  });

  it('runs every function registered during a call, in order, once the last call settles', async () => {
    const deadline = new RequestDeadline(Date.now() + 1000);
    const first = pendingCall();
    const second = pendingCall();
    const firstCall = deadline.track(first.call);
    const secondCall = deadline.track(second.call);
    const ran: string[] = [];
    deadline.onceIdle(() => ran.push('first'));
    deadline.onceIdle(() => ran.push('second'));

    first.settle();
    await firstCall;
    expect(ran).toEqual([]);
    second.settle();
    await secondCall;
    expect(ran).toEqual(['first', 'second']);

    // Each ran once: a later idle moment does not replay them.
    const third = pendingCall();
    const thirdCall = deadline.track(third.call);
    third.settle();
    await thirdCall;
    expect(ran).toEqual(['first', 'second']);
  });
});
